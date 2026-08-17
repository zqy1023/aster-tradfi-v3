import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AIResearchService,
  InMemoryResearchRepository,
  OpenAICompatibleResearchProvider,
  ResearchValidationError,
} from './ai-research.mjs';
import { MySQLResearchRepository } from './mysql-research-repository.mjs';
import { TradFiDomain, TradFiDomainError, normalizeOkxInstrument } from './tradfi-domain.mjs';
import { OKXMarketGateway } from './okx-market-gateway.mjs';
import { OKXPrivateGateway } from './okx-private-gateway.mjs';
import { CredentialVault } from './credential-vault.mjs';
import { MySQLTradFiRepository } from './mysql-tradfi-repository.mjs';
import { AuthService } from './auth-service.mjs';
import { buildWorkstationSnapshot, buildReview } from './workstation-domain.mjs';
import { MarketEventService } from './market-events.mjs';
import { StrategyManager } from './strategy-manager.mjs';
import { EquityMomentumSource } from './equity-momentum-source.mjs';
import { PositionManager } from './position-manager.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const webDir = join(rootDir, 'web');
const port = Number(process.env.PORT || 4310);

const repository = process.env.V3_DB_ENABLED === 'true'
  ? await MySQLResearchRepository.fromEnv()
  : new InMemoryResearchRepository();
const authService = repository.pool ? new AuthService(repository.pool, process.env.V3_PROXY_AUTH_SECRET) : null;
const provider = process.env.AI_PROVIDER === 'openai-compatible'
  ? new OpenAICompatibleResearchProvider({ apiKey: process.env.AI_API_KEY, baseUrl: process.env.AI_BASE_URL, model: process.env.AI_MODEL })
  : null;
const credentialVault = process.env.V3_CREDENTIAL_KEY ? new CredentialVault(process.env.V3_CREDENTIAL_KEY) : null;
const domainRepository = process.env.V3_DB_ENABLED === 'true' ? new MySQLTradFiRepository(repository.pool) : null;
const liveMarketEnabled = process.env.OKX_WS_ENABLED === 'true';
const domain = new TradFiDomain({ credentialVault, repository: domainRepository, gateway: liveMarketEnabled });
const momentumSource = new EquityMomentumSource();
momentumSource.load().catch((error) => console.error('[momentum-source] 加载失败', error.message));

// —— 常驻仓位管理器：保护单完整性/去重/动态止损/仓位风险 ——
// 方向确信度（复用 momentum 排名，与报告一致）
function convictionFor(instId) {
  const sym = String(instId).replace(/-USDT-SWAP$/, '');
  const mom = momentumSource.momentumFor(instId) || momentumSource.rankMomentum().get(sym);
  if (!mom) return { level: '未知', mult: 1 };
  const pct = mom.rank / Math.max(1, mom.total);
  if (pct <= 0.1) return { level: '强烈', mult: 3.3 };
  if (pct <= 0.3) return { level: '明确', mult: 2.6 };
  if (pct <= 0.5) return { level: '中等', mult: 2.0 };
  return { level: '偏弱', mult: 1.0 };
}
// 合约 lotSz 缓存（避免频繁查 OKX）
const positionLotSzCache = new Map();
// 自动开单安全开关：默认 OFF，必须显式设 AUTO_TRADE_ENABLED=true 才开启
const positionManager = new PositionManager({
  domain,
  getGateway: (accountId) => accountGateways.get(accountId),
  getAlgos: (gateway) => gateway.listPendingAlgos('SWAP'),
  setProtection: (gateway, params) => gateway.setPositionProtection(params),
  cancelAlgo: (gateway, params) => gateway.cancelAlgo(params),
  // 减仓执行：市价只减仓单（通过 REST order 通道，reduceOnly）
  reducePosition: async (gateway, { instId, side, qty }) => {
    const intent = {
      id: `MGR${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      instId, side, orderType: 'market', size: qty, reduceOnly: true,
    };
    const result = await gateway.placeOrder(intent);
    domain.recordAudit({ tenantId: '1', userId: '1', role: 'admin' }, 'position.auto_reduce', { instId, side, qty, reason: '风险超上限自动减仓', result });
    return result;
  },
  // 开仓执行：市价单（自动开单用）
  placeOrder: async (gateway, intent) => {
    const result = await gateway.placeOrder(intent);
    domain.recordAudit({ tenantId: '1', userId: '1', role: 'admin' }, 'position.auto_open', { instId: intent.instId, side: intent.side, qty: intent.size, reason: '策略信号final自动开单', result });
    return result;
  },
  // 机会列表（自动开单信号源）：复用 buildWorkstation 完整构建（含K线就绪），15s硬超时
  getOpportunities: async () => {
    const principal = { tenantId: '1', userId: '1', role: 'admin' };
    const timer = setTimeout(() => { throw new Error('buildWorkstation超时'); }, 15_000);
    try {
      const snapshot = await buildWorkstation(principal).catch((e) => { process.stderr.write(`[仓位管理] buildWorkstation失败: ${e?.message}\n`); return { opportunities: [] }; });
      return (snapshot.opportunities || []).filter((o) => o.arbitration?.decision?.startsWith('final'));
    } finally { clearTimeout(timer); }
  },
  // 单个标的当前信号（持仓持续评估用）：从最近快照取该标的仲裁
  getSignal: async (instId) => {
    const principal = { tenantId: '1', userId: '1', role: 'admin' };
    const snapshot = await buildWorkstation(principal).catch(() => null);
    const opp = (snapshot?.opportunities || []).find((o) => o.instId === instId);
    return opp ? { decision: opp.arbitration?.decision, direction: opp.arbitration?.direction, label: opp.arbitration?.label } : null;
  },
  // 4H 动量（持仓退出检测）：30根4H收盘涨跌幅
  getH4Momentum: async (instId) => {
    const candles = domain.getCandles(instId, '4H').filter((c) => c.confirm !== false);
    if (candles.length < 31) return null;
    const start = Number(candles[candles.length - 31].close);
    const end = Number(candles[candles.length - 1].close);
    return start > 0 ? (end - start) / start : null;
  },
  conviction: convictionFor,
  // ATR 波动率：从 1D 已确认 K 线算 ATR14 / 现价（百分比）
  getAtrPct: async (instId) => {
    const candles = domain.candleSets?.[instId]?.['1D'] || domain.candleSets?.[instId]?.default || [];
    const confirmed = candles.filter((c) => c.confirm !== false && c.high && c.low).slice(-30);
    if (confirmed.length < 15) return 0.003;
    const trs = [];
    for (let i = 1; i < confirmed.length; i++) {
      const h = Number(confirmed[i].high), l = Number(confirmed[i].low), pc = Number(confirmed[i - 1].close);
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
    const price = Number(confirmed[confirmed.length - 1].close) || 1;
    return atr / price; // ATR% (如 0.01 = 1%)
  },
  // 合约最小下单量 lotSz：优先用 domain 已存 instruments，缺则查 OKX public instruments
  getLotSz: async (instId) => {
    const inst = [...domain.instruments.values()].find((i) => i.instId === instId);
    if (inst?.lotSz) return Number(inst.lotSz);
    const lotCache = positionLotSzCache.get(instId);
    if (lotCache) return lotCache;
    try {
      const resp = await okxFetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`, { headers: { 'user-agent': 'aster-tradfi-v3' } });
      const j = await resp.json();
      const lot = Number((j.data || [])[0]?.lotSz || 0.01);
      positionLotSzCache.set(instId, lot);
      return lot;
    } catch { return 0.01; }
  },
  onNotify: async (actions) => {
    // 每条动作通知都带上当前信号状态（用户要求：仓位通知提示最新信号）
    const lines = [];
    for (const a of actions) {
      const sig = await positionManager.getSignal(a.instId).catch(() => null);
      const h4 = await positionManager.getH4Momentum(a.instId).catch(() => null);
      const sigTxt = sig ? `信号:${sig.label || sig.decision}(${sig.direction || '?'})` : '信号:未知';
      const momTxt = h4 !== null ? `4H动量:${(h4 * 100).toFixed(2)}%` : '4H动量:数据不足';
      lines.push(`[仓位管理] ${a.action} ${a.instId} — ${a.detail} | ${sigTxt} · ${momTxt}`);
    }
    process.stderr.write(lines.join('\n') + '\n');
    // 推送到实盘助手 QQ 机器人
    pushQQReport(lines.join('\n')).catch((error) => process.stderr.write(`[仓位管理] QQ推送失败 ${error?.message}\n`));
  },
});
// 自动开单默认关闭，AUTO_TRADE_ENABLED=true 才开启（安全闸）
positionManager.autoOpenEnabled = process.env.AUTO_TRADE_ENABLED === 'true';
const marketEventService = new MarketEventService({ repository: domainRepository });
const strategyManager = new StrategyManager({ repository: domainRepository });

// —— 实盘助手 QQ 机器人推送（复用仓位报告通道）——
const QQ_APP_ID = '1905392792';
const QQ_APP_SECRET = 'HFEDDDEFHJMPTXciov2AIRaku5GSer4I';
const QQ_OPENID = '0BDDCDB92BC6BDBE131D6641BDDDD4F1';
async function pushQQReport(content) {
  const tokenResp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: QQ_APP_ID, clientSecret: QQ_APP_SECRET }),
    signal: AbortSignal.timeout(15000),
  });
  const tokenJson = await tokenResp.json();
  const token = tokenJson.access_token;
  if (!token) throw new Error(`QQ token 获取失败：${tokenJson.message || 'unknown'}`);
  const resp = await fetch(`https://api.sgroup.qq.com/v2/users/${QQ_OPENID}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content, msg_type: 0 }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await resp.json();
  if (!json.id) throw new Error(`QQ 发送失败：${json.message || json.code || 'unknown'}`);
  return json;
}

// 高频市场快照批量落库（5s 节流），避免逐条写库撑爆连接池与堆
if (domainRepository) {
  let persisting = false;
  setInterval(() => {
    if (persisting) return; // 上一批未完成则跳过，防止 DB 慢时队列无限积压
    persisting = true;
    domain.persistMarketSnapshots()
      .catch((error) => console.error('[persist]', error.message))
      .finally(() => { persisting = false; });
  }, 5_000).unref();
}

// 仓位管理器定时兜底：30s 一轮，即使私有 WS 静默也定期检查保护单/仓位
setInterval(() => {
  positionManager.evaluate({ force: true })
    .then((res) => { if (res && (res.error || res.actions?.length)) process.stderr.write(`[仓位管理] 评估: ${JSON.stringify(res)}\n`); })
    .catch((error) => process.stderr.write(`[仓位管理] 评估异常 ${error?.stack || error}\n`));
}, 30_000).unref();
// 启动自检：8 秒后手动跑一次，确认管理器链路
setTimeout(() => {
  positionManager.evaluate({ force: true })
    .then((res) => process.stderr.write(`[仓位管理] 启动自检: ${JSON.stringify(res).slice(0, 300)}\n`))
    .catch((error) => process.stderr.write(`[仓位管理] 启动自检异常 ${error?.stack || error}\n`));
}, 8_000).unref();
const service = new AIResearchService({
  repository,
  provider,
  instrumentCatalog: {
    discover: async (scope) => {
      const requested = new Set((scope || []).map(String));
      const equities = domain.listInstruments({ tenantId: 'catalog', userId: 'catalog', role: 'admin' }, 'equity')
        .filter((instrument) => String(instrument.instId).endsWith('-USDT-SWAP') && instrument.state === 'live');
      const selected = equities.filter((instrument) => requested.has(instrument.instId));
      return (selected.length ? selected : equities.slice(0, 20)).map((instrument) => ({ ...instrument, sourceChannel: 'OKX public instruments WS' }));
    },
  },
});
let okxGateway = null;
let okxBusinessGateway = null;
const accountGateways = new Map();
const detailSubscriptions = new Map();
const marketClients = new Map();
const marketFlushTimers = new Map();
const privateClients = new Map();
const overviewClients = new Map();
const overviewFlushTimers = new Map();

function writeEvent(res, payload, event = 'message') {
  if (res.destroyed || res.writableEnded) return false;
  return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function compactMarketDetail(detail) {
  if (!detail) return null;
  const candles = Array.isArray(detail.candles) ? detail.candles : [];
  return { ...detail, candleCount: candles.length, candles: candles.slice(-2) };
}

// 序列化前剥离 K 线原始数组，减小 workstation 响应体积（raw 仅用于入库，前端不需要）
function stripCandleRaw(candle) {
  if (!candle || typeof candle !== 'object') return candle;
  const { raw, ...rest } = candle;
  return rest;
}

// —— OKX REST 全局限流（8 req/s 令牌桶，远低于 OKX 20 req/2s 限制）——
const okxRateTokens = { count: 0, resetAt: Date.now() + 1000 };
async function okxRateLimit() {
  const now = Date.now();
  if (now >= okxRateTokens.resetAt) { okxRateTokens.count = 0; okxRateTokens.resetAt = now + 1000; }
  if (okxRateTokens.count >= 8) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, okxRateTokens.resetAt - now)));
    return okxRateLimit();
  }
  okxRateTokens.count += 1;
}

async function okxFetch(url, options = {}, timeoutMs = 12_000) {
  await okxRateLimit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OKX REST 请求超时（${timeoutMs}ms）：${String(url).slice(0, 90)}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleMarketBroadcast(instId) {
  if (!instId || marketFlushTimers.has(instId)) return;
  const timer = setTimeout(() => {
    marketFlushTimers.delete(instId);
    for (const [res, client] of marketClients.entries()) {
      if (client.instId !== instId || client.backpressured) continue;
      const detail = compactMarketDetail(domain.marketDetail(client.principal, instId, client.bar));
      if (detail && !writeEvent(res, detail)) client.backpressured = true;
    }
  }, 200);
  marketFlushTimers.set(instId, timer);
}

const privateFlushTimers = new Map();

async function broadcastPrivate(principal) {
  // 订单/持仓/成交 + 风险中心（权益/可用/今日盈亏）一起推送，实盘页实时刷新
  const [payload, risk] = await Promise.all([
    domain.privateTradingData(principal),
    domain.riskOverview(principal),
  ]);
  payload.risk = risk;
  for (const [res, client] of privateClients.entries()) {
    if (client.backpressured) continue;
    if (client.principal.tenantId === principal.tenantId && (client.principal.role === 'admin' || client.principal.userId === principal.userId) && !writeEvent(res, payload)) client.backpressured = true;
  }
}

// 私有事件广播节流：1s 窗口内合并多次推送为一次，避免成交高峰每事件 4 个全量 DB 查询
function schedulePrivateBroadcast(principal) {
  const key = `${principal.tenantId}|${principal.userId}`;
  if (privateFlushTimers.has(key)) return;
  const timer = setTimeout(() => {
    privateFlushTimers.delete(key);
    broadcastPrivate(principal).catch((error) => process.stderr.write(`[private-ws] 广播失败 ${error?.message || error}\n`));
  }, 1_000);
  privateFlushTimers.set(key, timer);
}

// —— 首页机会雷达实时推送：行情 ticker 到达时 1s 节流推送轻量快照（marketState + opportunities 摘要）——
async function pushOverview(principal) {
  if (!overviewClients.size) return;
  const instruments = domain.listInstruments(principal, '');
  const marketItems = domain.marketSnapshot(principal, '');
  const ranked = marketItems
    .filter((item) => item.instrument?.assetClass === 'equity' && String(item.instId).endsWith('-USDT-SWAP'))
    .sort((a, b) => Number(b.volume24h || 0) - Number(a.volume24h || 0));
  const selected = ranked.length ? ranked.slice(0, 12) : [];
  const candleSets = Object.fromEntries(selected.map((item) => [item.instId, {
    '4H': domain.getCandles(item.instId, '4H').slice(-240).map(stripCandleRaw),
    '1D': domain.getCandles(item.instId, '1D').slice(-240).map(stripCandleRaw),
    '1W': domain.getCandles(item.instId, '1W').slice(-240).map(stripCandleRaw),
    default: domain.getCandles(item.instId, '15m').slice(-240).map(stripCandleRaw),
  }]));
  const risk = await domain.riskOverview(principal);
  const momentumRank = momentumSource.rankMomentum();
  const snapshot = buildWorkstationSnapshot({
    instruments,
    marketItems,
    candleSets,
    connection: domain.connection(),
    risk,
    enabledStrategies: strategyManager.enabledTypes(),
    privateData: { source: 'okx-private-ws', fills: [], exchangeOrders: [], positions: [], intents: [], review: { summary: {}, attribution: [], trades: [], nextActions: [] } },
    marketEvents: {},
    liveTrading: process.env.OKX_TRADING_ENABLED === 'true',
    momentumRank,
  });
  // 缓存最近快照供仓位管理器自动开单读取信号
  domain.lastWorkstationSnapshot = snapshot;
  const payload = {
    type: 'overview',
    generatedAt: new Date().toISOString(),
    marketState: snapshot.marketState,
    opportunities: snapshot.opportunities.map((item) => ({
      instId: item.instId, underlying: item.underlying, price: item.price, change24h: item.change24h,
      volume24h: item.volume24h, state: item.state, score: item.score, arbitration: item.arbitration?.label,
      trigger: item.trigger, source: item.source, recvTs: item.recvTs,
    })),
    strategyCouncil: snapshot.strategyCouncil?.map((item) => ({ instId: item.instId, arbitration: item.arbitration, signals: item.signals?.map((s) => ({ name: s.name, status: s.status, direction: s.direction, score: s.score })) })) || [],
    // 驾驶舱合约列表实时价格：instId → {last, change24h, volume24h}
    prices: Object.fromEntries(marketItems.map((item) => [item.instId, { last: item.last, change24h: item.change24h, volume24h: item.volume24h }])),
  };
  for (const [res, client] of overviewClients.entries()) {
    if (client.backpressured) continue;
    if (client.principal.tenantId === principal.tenantId && (client.principal.role === 'admin' || client.principal.userId === principal.userId) && !writeEvent(res, payload)) client.backpressured = true;
  }
}

// 行情消息到达时调度机会页推送（300ms 节流，所有标的合并为一次快照，按客户端 principal 分别生成）
// 前端合约列表已改为增量更新价格文本（非整表重绘），可承受更高频率
// 行情驱动仓位管理器：ticker 到达即触发评估（5s 节流），实现动态止损实时调整
let positionTickTimer = null;
function schedulePositionManagerTick() {
  if (positionTickTimer) return;
  positionTickTimer = setTimeout(() => {
    positionTickTimer = null;
    positionManager.evaluate({ force: true })
      .then((res) => { if (res?.error) process.stderr.write(`[仓位管理] 评估失败: ${res.error}\n`); else if (res?.actions?.length) process.stderr.write(`[仓位管理] 评估动作: ${JSON.stringify(res.actions).slice(0,200)}\n`); })
      .catch((error) => process.stderr.write(`[仓位管理] 评估异常 ${error?.stack || error}\n`));
  }, 15_000);
}
function scheduleOverviewPush() {
  if (!overviewClients.size) return;
  const uniquePrincipals = new Map();
  for (const client of overviewClients.values()) {
    const key = `${client.principal.tenantId}|${client.principal.userId}`;
    if (!uniquePrincipals.has(key)) uniquePrincipals.set(key, client.principal);
  }
  for (const [key, principal] of uniquePrincipals.entries()) {
    if (overviewFlushTimers.has(key)) continue;
    const timer = setTimeout(() => {
      overviewFlushTimers.delete(key);
      pushOverview(principal).catch((error) => process.stderr.write(`[overview] 推送失败 ${error?.message || error}\n`));
    }, 300);
    overviewFlushTimers.set(key, timer);
  }
}

if (liveMarketEnabled) {
  okxGateway = new OKXMarketGateway({
    url: process.env.OKX_PUBLIC_WS_URL,
    onMessage: (message) => {
      try {
        domain.ingestMarketMessage(message);
        scheduleMarketBroadcast(message.instId);
        if (message.type === 'tickers') { scheduleOverviewPush(); schedulePositionManagerTick(); }
      } catch (error) {
        process.stderr.write(`[public-ws] 处理行情消息异常 ${message?.type || 'unknown'}: ${error?.stack || error}\n`);
      }
    },
    onState: (state) => Object.assign(domain.gatewayState, state),
  });
  try {
    okxGateway.connect();
    okxGateway.subscribe([
      { channel: 'instruments', instType: 'SWAP' },
      { channel: 'instruments', instType: 'FUTURES' },
    ]);
  } catch (error) {
    Object.assign(domain.gatewayState, { status: 'degraded', message: error.message });
  }
  okxBusinessGateway = new OKXMarketGateway({
    url: process.env.OKX_BUSINESS_WS_URL || 'wss://ws.okx.com:8443/ws/v5/business',
    onMessage: (message) => {
      try {
        domain.ingestMarketMessage(message);
        scheduleMarketBroadcast(message.instId);
      } catch (error) {
        process.stderr.write(`[business-ws] 处理K线消息异常 ${message?.type || 'unknown'}: ${error?.stack || error}\n`);
      }
    },
    onState: (state) => Object.assign(domain.gatewayState, {
      businessStatus: state.status,
      businessMessage: state.message,
    }),
  });
  try { okxBusinessGateway.connect(); }
  catch (error) { Object.assign(domain.gatewayState, { businessStatus: 'degraded', businessMessage: error.message }); }
}

function ensureMarketSubscription(instId, bar = '15m') {
  if (!okxGateway || !domain.instruments.has(instId)) return;
  const existing = detailSubscriptions.get(instId);
  if (existing) {
    existing.lastAccess = Date.now();
    if (existing.bar !== bar) {
      okxBusinessGateway?.unsubscribe([{ channel: `candle${existing.bar}`, instId }]);
      okxBusinessGateway?.subscribe([{ channel: `candle${bar}`, instId }]);
      existing.bar = bar;
    }
  } else {
    if (detailSubscriptions.size >= 60) {
      const [oldestInstId, oldest] = [...detailSubscriptions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
      okxGateway.unsubscribe([{ channel: 'books5', instId: oldestInstId }, { channel: 'trades', instId: oldestInstId }]);
      okxBusinessGateway?.unsubscribe([{ channel: `candle${oldest.bar}`, instId: oldestInstId }]);
      detailSubscriptions.delete(oldestInstId);
    }
    okxGateway.subscribe([{ channel: 'books5', instId }, { channel: 'trades', instId }]);
    okxBusinessGateway?.subscribe([{ channel: `candle${bar}`, instId }]);
    detailSubscriptions.set(instId, { bar, lastAccess: Date.now() });
  }
  domain.gatewayState.subscriptions = [`tickers:${domain.instruments.size}`, `实时详情:${detailSubscriptions.size}`, `当前周期:${bar}`];
}

async function discoverTradFiInstruments() {
  if (!okxGateway) return;
  const discovered = [];
  for (const instType of ['SWAP', 'FUTURES']) {
    const response = await okxFetch(`https://www.okx.com/api/v5/public/instruments?instType=${instType}`, { headers: { 'user-agent': 'aster-tradfi-v3' } });
    if (!response.ok) throw new Error(`OKX 合约目录请求失败：${response.status}`);
    const payload = await response.json();
    const rows = (payload.data || []).filter((row) => normalizeOkxInstrument(row).assetClass !== 'unknown');
    discovered.push(...(domain.ingestMarketMessage({ type: 'instruments', data: rows, sourceTs: new Date().toISOString(), recvTs: new Date().toISOString(), raw: payload }) || []));
  }
  const unique = [...new Set(discovered)];
  const args = unique.flatMap((instId) => [{ channel: 'tickers', instId }, { channel: 'funding-rate', instId }]);
  for (let index = 0; index < args.length; index += 80) okxGateway.subscribe(args.slice(index, index + 80));
  const initial = unique.find((instId) => instId === 'AAPL-USDT-SWAP') || unique.find((instId) => instId.startsWith('AAPL-')) || unique[0];
  if (initial) ensureMarketSubscription(initial, '15m');
  Object.assign(domain.gatewayState, { message: `OKX WS 已连接，已发现 ${discovered.length} 个 TradFi 合约` });
}

if (liveMarketEnabled) discoverTradFiInstruments().catch((error) => Object.assign(domain.gatewayState, { status: 'degraded', message: error.message }));

const candleBootstrap = new Map();
const validBars = new Set(['1m', '5m', '15m', '1H', '4H', '1D', '1W']);
async function ensureMarketCandles(instId, requestedBar = '15m', { background = false } = {}) {
  const bar = validBars.has(requestedBar) ? requestedBar : '15m';
  const key = `${instId}|${bar}`;
  const target = Math.max(200, Math.min(300, Number(process.env.OKX_HISTORY_CANDLE_LIMIT || 1000)));
  ensureMarketSubscription(instId, bar);
  if (domain.getCandles(instId, bar).length < 200 && domainRepository) {
    const saved = await domainRepository.loadMarketCandles(instId, bar, 5000);
    if (saved.length) domain.setHistoricalCandles(instId, bar, saved, { persist: false });
  }
  if (domain.getCandles(instId, bar).length >= target) return;
  if (candleBootstrap.has(key)) return background ? undefined : candleBootstrap.get(key);
  const task = (async () => {
    let cursor = null;
    let previousCursor = null;
    while (domain.getCandles(instId, bar).length < target) {
      const query = new URLSearchParams({ instId, bar, limit: '100' });
      if (cursor) query.set('after', cursor);
      const response = await okxFetch(`https://www.okx.com/api/v5/market/history-candles?${query}`, { headers: { 'user-agent': 'aster-tradfi-v3' } });
      if (!response.ok) break;
      const payload = await response.json();
      const rows = payload.data || [];
      if (!rows.length) break;
      const candles = rows.map((row) => ({ ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), confirm: row[8] === '1' || row[8] === 1, source: 'okx-rest-history', sourceTs: row[0], recvTs: new Date().toISOString(), raw: row }));
      if (domainRepository) await domainRepository.upsertMarketCandles(instId, bar, candles);
      domain.setHistoricalCandles(instId, bar, candles, { persist: false });
      previousCursor = cursor;
      cursor = String(Math.min(...candles.map((candle) => candle.ts)));
      if (!cursor || cursor === previousCursor || rows.length < 100) break;
    }
    scheduleMarketBroadcast(instId);
  })().finally(() => candleBootstrap.delete(key));
  candleBootstrap.set(key, task);
  if (background) {
    task.catch((error) => console.error(`[market-history] ${key}`, error));
    return;
  }
  return task;
}

async function buildWorkstation(principal) {
  const instruments = domain.listInstruments(principal, '');
  const marketItems = domain.marketSnapshot(principal, '');
  const ranked = marketItems
    .filter((item) => item.instrument?.assetClass === 'equity' && String(item.instId).endsWith('-USDT-SWAP'))
    .sort((a, b) => Number(b.volume24h || 0) - Number(a.volume24h || 0));
  const selected = ranked.length ? ranked.slice(0, 12) : marketItems.filter((item) => item.instrument?.assetClass === 'equity').slice(0, 12);
  await Promise.all(selected.slice(0, 6).flatMap((item) => ['4H', '1D', '1W'].map((bar) => ensureMarketCandles(item.instId, bar, { background: true }))));
  const candleSets = Object.fromEntries(selected.map((item) => [item.instId, {
    '4H': domain.getCandles(item.instId, '4H').slice(-240).map(stripCandleRaw),
    '1D': domain.getCandles(item.instId, '1D').slice(-240).map(stripCandleRaw),
    '1W': domain.getCandles(item.instId, '1W').slice(-240).map(stripCandleRaw),
    default: domain.getCandles(item.instId, '15m').slice(-240).map(stripCandleRaw),
  }]));
  const [risk, privateData, review] = await Promise.all([
    domain.riskOverview(principal),
    domain.privateTradingData(principal),
    domain.dailyReview(principal),
  ]);
  privateData.review = review;
  const marketEvents = await marketEventService.load(selected.map((item) => item.instrument?.underlying)).catch((error) => ({ generatedAt: new Date().toISOString(), macro: [], earnings: [], state: 'disconnected', errors: [error.message] }));
  return buildWorkstationSnapshot({
    instruments,
    marketItems,
    candleSets,
    connection: domain.connection(),
    enabledStrategies: strategyManager.enabledTypes(),
    risk,
    privateData,
    marketEvents,
    liveTrading: process.env.OKX_TRADING_ENABLED === 'true',
    momentumRank: momentumSource.rankMomentum(),
  });
}

async function connectAccount(principal, accountId) {
  await domain.listAccounts(principal);
  await domain.listOrders(principal);
  const { account, credentials } = domain.credentialsFor(principal, accountId);
  accountGateways.get(accountId)?.close();
  const gateway = new OKXPrivateGateway({
    accountId,
    credentials,
    onState: (state) => domain.setAccountStatus(principal, accountId, { status: state.status === 'connected' ? 'connected' : state.status === 'disconnected' ? 'pending' : 'degraded', lastSyncAt: state.lastSyncAt, message: state.message }),
    onEvent: (event) => {
      try {
        domain.setAccountStatus(principal, accountId, { lastSyncAt: event.recvTs });
        domain.ingestPrivateEvent(principal, accountId, event);
        // 持仓/成交事件到达 → 触发仓位管理器评估（15s 节流）
        const ch = event?.payload?.arg?.channel;
        if (ch === 'positions' || ch === 'orders' || ch === 'fills') {
          positionManager.evaluate().catch(() => undefined);
        }
      } catch (error) {
        process.stderr.write(`[private-ws] 处理私有事件异常 ${event?.payload?.arg?.channel || 'unknown'}: ${error?.stack || error}\n`);
      }
      schedulePrivateBroadcast(principal);
    },
  });
  accountGateways.set(accountId, gateway);
  gateway.connect();
  return account;
}

async function initializePrivateAccounts() {
  if (!domainRepository || !credentialVault || !repository.pool) return;
  const bootstrapFile = process.env.OKX_BOOTSTRAP_CREDENTIAL_FILE;
  if (bootstrapFile) {
    const raw = JSON.parse(await readFile(bootstrapFile, 'utf8'));
    const credentials = raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : raw;
    const apiKey = credentials.apiKey || credentials.apikey || credentials.api_key;
    const secretKey = credentials.secretKey || credentials.secretkey || credentials.secret_key;
    const passphrase = credentials.passphrase || credentials.Passphrase;
    if (apiKey && secretKey && passphrase) {
      const [admins] = await repository.pool.execute("SELECT id,tenant_id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1");
      const admin = admins[0];
      if (admin) {
        const principal = { tenantId: String(admin.tenant_id), userId: String(admin.id), role: 'admin' };
        const name = String(credentials.name || credentials.remark || credentials.note || 'Kevin · OKX 实盘').slice(0, 100);
        const accounts = await domain.listAccounts(principal);
        let account = accounts.find((item) => item.environment === 'live' && item.name === name) || accounts.find((item) => item.environment === 'live');
        if (account) {
          const cipher = credentialVault.seal({ apiKey: String(apiKey), secretKey: String(secretKey), passphrase: String(passphrase) });
          await domainRepository.updateAccountCredentials(account.id, principal.tenantId, cipher);
          const stored = domain.accounts.get(account.id);
          if (stored) { stored.credentialCipher = cipher; stored.status = 'pending'; }
        } else {
          account = await domain.createAccount(principal, { name, environment: 'live', apiKey, secretKey, passphrase });
        }
      }
    }
  }
  const accounts = await domainRepository.listAllLiveAccounts();
  for (const account of accounts) {
    domain.accounts.set(account.id, account);
    const principal = { tenantId: account.tenantId, userId: account.ownerUserId, role: 'admin' };
    try { await connectAccount(principal, account.id); } catch { domain.setAccountStatus(principal, account.id, { status: 'degraded', message: 'OKX 私有连接初始化失败，请检查凭证与 IP 白名单' }); }
  }
}

initializePrivateAccounts().catch(() => undefined);

// —— 启动重放：扫描悬置的 order_outbox（进程在 placeOrder 前后崩溃留下的 pending/failed 记录）——
async function replayOutbox() {
  if (!domainRepository?.listPendingOutbox || !process.env.OKX_TRADING_ENABLED === 'true') return;
  try {
    const pending = await domainRepository.listPendingOutbox();
    if (!pending.length) return;
    process.stderr.write(`[outbox] 发现 ${pending.length} 条悬置订单，标记为待人工对账\n`);
    for (const item of pending) {
      const intentId = item.intentId;
      const intent = domain.intents.get(intentId);
      // 无法确认下单前还是下单后崩溃：幂等 clOrdId 允许重放，但保守起见标记 unknown 并生成审计
      const principal = { tenantId: item.tenantId, userId: '1', role: 'admin' };
      if (intent) {
        intent.status = 'unknown';
        intent.updatedAt = new Date().toISOString();
        domain.recordAudit(principal, 'order.outbox_replay', { orderId: intentId, reason: '重启后扫描到悬置提交，状态标为待对账', exchangeOrderId: intent.exchangeOrderId });
        await domainRepository.updateOrderIntent(intent).catch(() => undefined);
      }
      await domainRepository.markOutboxDead(intentId, '重启后无法确认交易所状态，已标记待人工对账');
    }
    process.stderr.write('[outbox] 悬置订单处理完成\n');
  } catch (error) {
    process.stderr.write(`[outbox] 重放扫描失败 ${error?.message || error}\n`);
  }
}
setTimeout(replayOutbox, 2_000).unref();

const mimeTypes = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' });

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function principalFrom(req) {
  const sessionPrincipal = authService?.principalFrom(req);
  if (sessionPrincipal) return sessionPrincipal;
  const tenantId = req.headers['x-tenant-id'];
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-role'];
  const suppliedSecret = String(req.headers['x-auth-secret'] || '');
  const expectedSecret = String(process.env.V3_PROXY_AUTH_SECRET || '');
  const secretValid = suppliedSecret.length > 0 && suppliedSecret.length === expectedSecret.length && timingSafeEqual(Buffer.from(suppliedSecret), Buffer.from(expectedSecret));
  if (process.env.V3_TRUST_PROXY_AUTH === 'true' && secretValid && tenantId && userId && role) return { tenantId: String(tenantId), userId: String(userId), role: String(role) };
  return null;
}

function requirePrincipal(req, res, roles = []) {
  const principal = principalFrom(req);
  if (!principal) { json(res, 401, { error: '需要登录' }); return null; }
  if (roles.length && !roles.includes(principal.role)) { json(res, 403, { error: '当前角色没有执行该操作的权限' }); return null; }
  return principal;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new ResearchValidationError('请求体不能超过 256 KB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ResearchValidationError('请求体不是有效 JSON'); }
}

function scopedJob(principal, job) {
  return job && String(job.tenantId) === String(principal.tenantId) ? job : null;
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(webDir, requested));
  const root = resolve(webDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) { json(res, 400, { error: '非法路径' }); return; }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': mimeTypes[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  } catch { json(res, 404, { error: '页面不存在' }); }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', process.env.V3_CORS_ORIGIN || 'http://127.0.0.1:4310');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/v3/auth/login' && req.method === 'POST') {
      if (!authService) { json(res, 503, { error: '认证服务未配置' }); return; }
      const input = await readJson(req);
      const username = String(input.username || '').trim();
      const result = await authService.login(username, String(input.password || ''), `${req.socket.remoteAddress || 'unknown'}:${username}`);
      if (!result) { res.setHeader('retry-after', '60'); json(res, 401, { error: '账号或密码错误' }); return; }
      res.setHeader('set-cookie', authService.cookie(result.token));
      json(res, 200, { user: result.user, expiresAt: new Date(result.expiresAt).toISOString() });
      return;
    }
    if (url.pathname === '/api/v3/auth/session' && req.method === 'GET') {
      const user = authService?.userFrom(req);
      if (!user) { json(res, 401, { error: '需要登录' }); return; }
      json(res, 200, { user });
      return;
    }
    if (url.pathname === '/api/v3/auth/logout' && req.method === 'POST') {
      authService?.logout(req);
      if (authService) res.setHeader('set-cookie', authService.clearCookie());
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/health') {
      json(res, 200, { service: 'aster-tradfi-v3', status: 'ok', aiProvider: provider?.name || 'unconfigured', storage: repository.constructor.name, liveTrading: process.env.OKX_TRADING_ENABLED === 'true', marketGateway: domain.connection(), time: new Date().toISOString() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/api/v3/overview' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const [orders, runs, risk] = await Promise.all([domain.listOrders(principal), domain.listRuns(principal), domain.riskOverview(principal)]);
      json(res, 200, { generatedAt: new Date().toISOString(), market: domain.connection(), kpis: { activeRuns: runs.filter((run) => run.status === 'running').length, ordersToday: orders.length, openPositions: risk.openPositions, todayPnl: risk.todayPnl }, alerts: risk.recentEvents, next: [{ title: '检查 AI 候选的前向验证证据', owner: 'AI 研究', state: '待处理' }, { title: '确认账户 WS 对账状态', owner: '账户连接', state: '进行中' }] });
      return;
    }

    if (url.pathname === '/api/v3/workstation' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, await buildWorkstation(principal));
      return;
    }

    if (url.pathname === '/api/v3/markets/instruments' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { source: 'okx-ws', instruments: domain.listInstruments(principal, url.searchParams.get('assetClass') || '') });
      return;
    }

    if (url.pathname === '/api/v3/markets/snapshot' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { source: 'okx-ws', connection: domain.connection(), items: domain.marketSnapshot(principal, url.searchParams.get('instId') || '') });
      return;
    }

    if (url.pathname === '/api/v3/markets/stream' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const instId = url.searchParams.get('instId') || '';
      const bar = validBars.has(url.searchParams.get('bar')) ? url.searchParams.get('bar') : '15m';
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      // scope=overview：首页机会雷达实时推送（无 instId 时）
      if (!instId) {
        const client = { principal, overview: true, heartbeat: null, backpressured: false, lastPushAt: 0 };
        client.heartbeat = setInterval(() => { if (!res.destroyed && !client.backpressured && !res.write(': heartbeat\n\n')) client.backpressured = true; }, 15_000);
        res.on('drain', () => { client.backpressured = false; });
        overviewClients.set(res, client);
        // 立即推一版初始数据
        pushOverview(principal).catch((error) => writeEvent(res, { error: error.message }, 'error'));
        req.on('close', () => { clearInterval(client.heartbeat); overviewClients.delete(res); });
        return;
      }
      if (!domain.instruments.has(instId)) { json(res, 404, { error: '合约不存在' }); return; }
      const client = { principal, instId, bar, heartbeat: null, backpressured: false };
      client.heartbeat = setInterval(() => { if (!res.destroyed && !client.backpressured && !res.write(': heartbeat\n\n')) client.backpressured = true; }, 15_000);
      res.on('drain', () => { client.backpressured = false; });
      marketClients.set(res, client);
      ensureMarketCandles(instId, bar, { background: false }).then(() => {
        const detail = compactMarketDetail(domain.marketDetail(principal, instId, bar));
        if (detail) writeEvent(res, detail);
      }).catch((error) => writeEvent(res, { error: error.message }, 'error'));
      req.on('close', () => { clearInterval(client.heartbeat); marketClients.delete(res); });
      return;
    }

    const marketDetailMatch = url.pathname.match(/^\/api\/v3\/markets\/([^/]+)$/);
    if (marketDetailMatch && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const instId = decodeURIComponent(marketDetailMatch[1]);
      const bar = validBars.has(url.searchParams.get('bar')) ? url.searchParams.get('bar') : '15m';
      await ensureMarketCandles(instId, bar, { background: false });
      const detail = domain.marketDetail(principal, instId, bar);
      if (!detail) { json(res, 404, { error: '合约不存在' }); return; }
      json(res, 200, detail); return;
    }

    if (url.pathname === '/api/v3/markets/connection' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, domain.connection()); return;
    }

    if (url.pathname === '/api/v3/accounts' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { accounts: await domain.listAccounts(principal) }); return;
    }

    if (url.pathname === '/api/v3/accounts' && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'trader']); if (!principal) return;
      const account = await domain.createAccount(principal, await readJson(req));
      if (account.environment === 'live') connectAccount(principal, account.id).catch(() => domain.setAccountStatus(principal, account.id, { status: 'degraded', message: 'OKX 私有连接失败，请检查凭证与 IP 白名单' }));
      json(res, 201, { account }); return;
    }
    const accountConnectMatch = url.pathname.match(/^\/api\/v3\/accounts\/([^/]+)\/connect$/);
    if (accountConnectMatch && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'trader']); if (!principal) return;
      const accountId = decodeURIComponent(accountConnectMatch[1]);
      const account = await connectAccount(principal, accountId);
      json(res, 202, { account, message: '已发起 OKX 私有 WebSocket 登录验证，请稍后刷新连接状态' }); return;
    }

    if (url.pathname === '/api/v3/runs' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { runs: await domain.listRuns(principal) }); return;
    }
    if (url.pathname === '/api/v3/runs' && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'researcher', 'trader']); if (!principal) return;
      json(res, 202, { run: await domain.createRun(principal, await readJson(req)) }); return;
    }

    // —— 策略管理 ——
    if (url.pathname === '/api/v3/strategies' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { strategies: await strategyManager.list(principal) }); return;
    }
    const strategyToggleMatch = url.pathname.match(/^\/api\/v3\/strategies\/([^/]+)\/toggle$/);
    if (strategyToggleMatch && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin']); if (!principal) return;
      const key = decodeURIComponent(strategyToggleMatch[1]);
      const body = await readJson(req);
      const enabled = Boolean(body.enabled);
      try {
        const result = await strategyManager.setEnabled(principal, key, enabled);
        domain.recordAudit(principal, 'strategy.toggle', { key, enabled });
        json(res, 200, { ...result, message: enabled ? '策略已启用' : '策略已停用' }); return;
      } catch (error) {
        json(res, 404, { error: error.message }); return;
      }
    }

    if (url.pathname === '/api/v3/orders' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const [data, risk] = await Promise.all([domain.privateTradingData(principal), domain.riskOverview(principal)]);
      json(res, 200, { ...data, orders: data.intents, risk }); return;
    }
    // 取消算法保护单（动态止损/条件单）
    if (url.pathname === '/api/v3/positions/algos/cancel' && req.method === 'POST') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const input = await readJson(req);
      const { instId, algoId } = input;
      if (!instId || !algoId) { json(res, 400, { error: '缺少 instId/algoId' }); return; }
      const accounts = await domain.listAccounts(principal);
      const account = accounts.find((a) => a.environment === 'live');
      const gateway = account ? accountGateways.get(account.id) : null;
      if (!gateway || gateway.status !== 'connected') { json(res, 409, { error: 'OKX 私有连接未就绪' }); return; }
      const result = await gateway.cancelAlgo({ instId, algoId });
      domain.recordAudit(principal, 'position.algo_cancel', { instId, algoId, reason: '清理重复保护单', result });
      json(res, 200, { ok: true, result });
      return;
    }

    // 查询已有持仓的算法保护单（动态止损/止盈止损）
    if (url.pathname === '/api/v3/positions/algos' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const accounts = await domain.listAccounts(principal);
      const account = accounts.find((a) => a.environment === 'live');
      const gateway = account ? accountGateways.get(account.id) : null;
      if (!gateway || gateway.status !== 'connected') { json(res, 409, { error: 'OKX 私有连接未就绪' }); return; }
      const [algos, history] = await Promise.all([
        gateway.listPendingAlgos('SWAP'),
        gateway.listAlgoHistory('SWAP').catch(() => []),
      ]);
      json(res, 200, { algos, history });
      return;
    }

    // 为已有持仓挂 OKX 原生移动止损（只减仓）
    // 为已有持仓挂止损/止盈（保护性操作，不改变仓位）
    if (url.pathname === '/api/v3/positions/protection' && req.method === 'POST') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const input = await readJson(req);
      const { instId, slTriggerPx, tpTriggerPx, closeFraction = 1 } = input;
      if (!instId) { json(res, 400, { error: '缺少 instId' }); return; }
      if (!slTriggerPx && !tpTriggerPx) { json(res, 400, { error: '至少提供 slTriggerPx 或 tpTriggerPx' }); return; }
      // 找账户网关
      const accounts = await domain.listAccounts(principal);
      const account = accounts.find((a) => a.environment === 'live');
      if (!account) { json(res, 400, { error: '未找到实盘账户' }); return; }
      const gateway = accountGateways.get(account.id);
      if (!gateway || gateway.status !== 'connected') { json(res, 409, { error: 'OKX 私有连接未就绪' }); return; }
      // 校验当前持仓存在且方向匹配
      const position = (domain.positions.get(`${account.id}|${instId}|net`) || domain.positions.get(`${account.id}|${instId}|long`) || domain.positions.get(`${account.id}|${instId}|short`));
      const isLong = position ? position.side === 'long' : true;
      if (position && Number(position.quantity) === 0) { json(res, 400, { error: '该标的无持仓' }); return; }
      const result = await gateway.setPositionProtection({
        instId,
        side: isLong ? 'sell' : 'buy',
        slTriggerPx: slTriggerPx ? Number(slTriggerPx) : null,
        tpTriggerPx: tpTriggerPx ? Number(tpTriggerPx) : null,
        closeFraction: Number(closeFraction) || 1,
      });
      domain.recordAudit(principal, 'position.protection', { instId, slTriggerPx, tpTriggerPx, result });
      json(res, 200, { ok: true, result });
      return;
    }
    if (url.pathname === '/api/v3/private/stream' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      const client = { principal, heartbeat: null, backpressured: false };
      client.heartbeat = setInterval(() => { if (!res.destroyed && !client.backpressured && !res.write(': heartbeat\n\n')) client.backpressured = true; }, 15_000);
      res.on('drain', () => { client.backpressured = false; });
      privateClients.set(res, client);
      domain.privateTradingData(principal).then((data) => writeEvent(res, data)).catch((error) => writeEvent(res, { error: error.message }, 'error'));
      req.on('close', () => { clearInterval(client.heartbeat); privateClients.delete(res); });
      return;
    }
    if (url.pathname === '/api/v3/orders/intents' && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'trader']); if (!principal) return;
      let order = await domain.createIntent(principal, await readJson(req));
      const account = (await domain.listAccounts(principal)).find((item) => item.id === order.accountId);
      if (!order.duplicate && order.status === 'outbox_pending' && account?.environment === 'live' && process.env.OKX_TRADING_ENABLED === 'true') {
        const gateway = accountGateways.get(account.id);
        if (!gateway || gateway.status !== 'connected') { json(res, 409, { error: '订单意图已保存，但 OKX 私有 WebSocket 未连接；系统不会绕过待确认状态下单', order }); return; }
        try {
          const ack = await gateway.placeOrder(order);
          const row = ack?.data?.[0] || {};
          if (row.sCode !== '0') {
            order = await domain.updateOrderStatus(principal, order.id, { status: 'unknown' });
            domain.recordAudit(principal, 'order.exchange_rejected', { orderId: order.id, exchangeCode: row.sCode || ack?.code || 'unknown', exchangeMessage: String(row.sMsg || ack?.msg || 'OKX 拒绝订单').slice(0, 240) });
            json(res, 422, { error: `OKX 拒绝订单：${row.sMsg || row.sCode || '未知原因'}`, order }); return;
          }
          order = await domain.updateOrderStatus(principal, order.id, { status: 'sent', exchangeOrderId: row.ordId || null });
        } catch (error) {
          order = await domain.updateOrderStatus(principal, order.id, { status: 'unknown' });
          domain.recordAudit(principal, 'order.exchange_unknown', { orderId: order.id, reason: String(error.message || error).slice(0, 240) });
          json(res, 502, { error: 'OKX 下单确认失败，订单状态标为待对账；请勿重复提交相同意图', order }); return;
        }
      }
      json(res, 201, { order, liveTrading: process.env.OKX_TRADING_ENABLED === 'true' }); return;
    }
    const orderCancelMatch = url.pathname.match(/^\/api\/v3\/orders\/([^/]+)\/cancel$/);
    if (orderCancelMatch && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'trader']); if (!principal) return;
      const orderId = decodeURIComponent(orderCancelMatch[1]);
      let order;
      const saved = (await domain.listOrders(principal)).find((item) => item.id === orderId);
      if (!saved) { json(res, 404, { error: '订单不存在' }); return; }
      const account = (await domain.listAccounts(principal)).find((item) => item.id === saved.accountId);
      if (account?.environment === 'live' && process.env.OKX_TRADING_ENABLED === 'true') {
        const gateway = accountGateways.get(account.id);
        if (!gateway || gateway.status !== 'connected') { json(res, 409, { error: 'OKX 私有 WebSocket 未连接，撤单保持待确认状态' }); return; }
        order = await domain.updateOrderStatus(principal, orderId, { status: 'cancel_pending' });
        try {
          const ack = await gateway.cancelOrder(order);
          const row = ack?.data?.[0] || {};
          if (row.sCode !== '0') {
            order = await domain.updateOrderStatus(principal, orderId, { status: 'unknown' });
            json(res, 422, { error: `OKX 拒绝撤单：${row.sMsg || row.sCode || '未知原因'}`, order }); return;
          }
          order = await domain.updateOrderStatus(principal, orderId, { status: 'cancel_pending' });
        } catch (error) {
          order = await domain.updateOrderStatus(principal, orderId, { status: 'unknown' });
          json(res, 502, { error: '撤单确认失败，状态标为待对账', order }); return;
        }
      } else order = await domain.cancelIntent(principal, orderId);
      if (!order) { json(res, 404, { error: '订单不存在' }); return; }
      json(res, 200, { order }); return;
    }

    if (url.pathname === '/api/v3/risk/overview' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, await domain.riskOverview(principal)); return;
    }
    if (url.pathname === '/api/v3/risk/check' && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'risk_admin', 'trader']); if (!principal) return;
      json(res, 200, domain.checkRisk(principal, await readJson(req))); return;
    }

    if (url.pathname === '/api/v3/reviews/trades' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      json(res, 200, { reviews: await domain.tradeReviews(principal) }); return;
    }
    if (url.pathname === '/api/v3/reviews/daily' && req.method === 'GET') {
      const principal = requirePrincipal(req, res); if (!principal) return;
      const date = url.searchParams.get('date') || '';
      const daily = await domain.dailyReview(principal, date);
      // 与 workstation 快照同构（buildReview 包装），前端可直接复用复盘渲染
      const privateData = await domain.privateTradingData(principal);
      json(res, 200, buildReview({ fills: privateData.fills || [], exchangeOrders: privateData.exchangeOrders || [], review: daily })); return;
    }
    if (url.pathname === '/api/v3/audit' && req.method === 'GET') {
      const principal = requirePrincipal(req, res, ['admin', 'auditor', 'risk_admin']); if (!principal) return;
      json(res, 200, { events: await domain.auditEvents(principal) }); return;
    }

    if (url.pathname === '/api/v3/ai/research' && req.method === 'GET') {
      const principal = requirePrincipal(req, res);
      if (!principal) return;
      const jobs = await repository.listJobs(principal.tenantId, 20);
      json(res, 200, { provider: provider?.name || 'unconfigured', jobs });
      return;
    }

    if (url.pathname === '/api/v3/ai/research' && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'researcher', 'trader']);
      if (!principal) return;
      const job = await service.start({ tenantId: principal.tenantId, userId: principal.userId, input: await readJson(req) });
      json(res, 202, { job, message: 'AI 研究任务已创建，正在生成研究证据' });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/v3\/ai\/research\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      const principal = requirePrincipal(req, res);
      if (!principal) return;
      const job = scopedJob(principal, await repository.getJob(jobMatch[1]));
      if (!job) { json(res, 404, { error: '研究任务不存在' }); return; }
      const candidate = job.candidateId ? await repository.getCandidate(job.candidateId) : null;
      json(res, 200, { job, candidate });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/v3\/ai\/research\/([^/]+)\/events$/);
    if (eventsMatch && req.method === 'GET') {
      const principal = requirePrincipal(req, res);
      if (!principal) return;
      const job = scopedJob(principal, await repository.getJob(eventsMatch[1]));
      if (!job) { json(res, 404, { error: '研究任务不存在' }); return; }
      json(res, 200, { events: await repository.getEvents(job.id) });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/v3\/ai\/research\/([^/]+)\/approval$/);
    if (approvalMatch && req.method === 'POST') {
      const principal = requirePrincipal(req, res, ['admin', 'approver', 'trader']);
      if (!principal) return;
      const job = scopedJob(principal, await repository.getJob(approvalMatch[1]));
      if (!job || !job.candidateId) { json(res, 404, { error: '没有可审批的研究候选' }); return; }
      const input = await readJson(req);
      const decision = input.decision || input.targetMode || 'live';
      const candidate = await repository.getCandidate(job.candidateId);
      if (!candidate) { json(res, 404, { error: '研究候选不存在' }); return; }
      if (decision === 'reject') {
        candidate.status = 'rejected';
        candidate.rejectedBy = principal.userId;
        candidate.rejectedAt = new Date().toISOString();
        await repository.saveCandidate(candidate);
        await service.record(job.id, '候选已退回 AI 重做', { rejectedBy: principal.userId, liveTradingAllowed: false });
        json(res, 200, { candidate, message: '候选已退回，下一轮研究必须重新生成版本' });
        return;
      }
      const targetMode = decision === 'paper' ? 'paper' : 'live';
      if (targetMode === 'live' && !['admin', 'approver'].includes(principal.role)) { json(res, 403, { error: '实盘准入必须由管理员或审批人确认' }); return; }
      if (targetMode === 'live') { json(res, 409, { error: '历史回测、前向滚动和压力测试尚未形成可验证证据，不能进入实盘准入' }); return; }
      if (candidate.status !== 'research_only') { json(res, 409, { error: '候选状态不允许审批' }); return; }
      candidate.status = targetMode === 'paper' ? 'paper_eligible' : 'live_eligible';
      candidate.approvedBy = principal.userId;
      candidate.approvedAt = new Date().toISOString();
      await repository.saveCandidate(candidate);
      await service.record(job.id, targetMode === 'paper' ? '已批准进入模拟运行' : '已批准进入实盘准入队列', { approvedBy: principal.userId, targetMode, liveTradingAllowed: targetMode === 'live' });
      json(res, 200, { candidate, message: targetMode === 'paper' ? '候选已进入模拟运行，不能直接下实盘单' : '候选已进入实盘准入队列，仍需完成交易所和风控验收' });
      return;
    }

    if (req.method === 'GET') { await serveStatic(req, res, url.pathname); return; }
    json(res, 404, { error: '接口不存在' });
  } catch (error) {
    if (error instanceof ResearchValidationError) { json(res, 400, { error: error.message, details: error.details }); return; }
    if (error instanceof TradFiDomainError) { json(res, error.status, { error: error.message }); return; }
    process.stderr.write(`[request-error] ${req.method} ${url.pathname} ${error?.stack || error}\n`);
    json(res, 500, { error: '服务内部错误' });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Aster TradFi Workstation V3 listening on 127.0.0.1:${port} provider=${provider?.name || 'unconfigured'}\n`);
});

// —— 进程级异常兜底：WS 行情/私有事件或后台任务出现未捕获异常时，记录并继续运行，而不是崩溃 ——
process.on('uncaughtException', (error) => {
  process.stderr.write(`[uncaughtException] ${error?.stack || error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}\n`);
});

// 优雅关闭：先断开 SSE 长连接与 WS 句柄，避免 close 回调被 keep-alive 阻塞导致被 systemd 强杀
function shutdown(signal) {
  process.stderr.write(`[shutdown] 收到 ${signal}，开始优雅关闭\n`);
  try {
    for (const [res, client] of marketClients.entries()) { clearInterval(client.heartbeat); res.destroy(); }
    for (const [res, client] of privateClients.entries()) { clearInterval(client.heartbeat); res.destroy(); }
    marketClients.clear();
    privateClients.clear();
    okxGateway?.close();
    okxBusinessGateway?.close();
    for (const gateway of accountGateways.values()) gateway?.close();
    server.closeAllConnections?.();
  } catch (error) {
    process.stderr.write(`[shutdown] 清理异常 ${error?.message || error}\n`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
