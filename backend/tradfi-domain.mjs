import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
const clone = (value) => structuredClone(value);
const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const eventTime = (value, fallback = null) => {
  const timestamp = finite(value, null);
  if (timestamp !== null) return timestamp;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const candleTimeframe = (channel = '') => String(channel).replace(/^candle/i, '') || '15m';
const exchangeFactId = (prefix, ...parts) => `${prefix}-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 28).toUpperCase()}`;
const publicAccount = (account) => {
  const { credentialCipher, ...safe } = account;
  return { ...clone(safe), canConnect: Boolean(credentialCipher) && account.environment === 'live' };
};

export class TradFiDomainError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'TradFiDomainError'; this.status = status; }
}

const INSTRUMENTS = [
  { instId: 'AAPL-USDT-SWAP', displayName: 'Apple 股票相关合约', assetClass: 'equity', underlying: 'AAPL', contractSize: 1, quoteCcy: 'USDT', settleCcy: 'USDT', tickSize: 0.01, lotSize: 1, tradingHours: '美股交易时段，以 OKX 返回为准', state: 'live' },
  { instId: 'NVDA-USDT-SWAP', displayName: 'NVIDIA 股票相关合约', assetClass: 'equity', underlying: 'NVDA', contractSize: 1, quoteCcy: 'USDT', settleCcy: 'USDT', tickSize: 0.01, lotSize: 1, tradingHours: '美股交易时段，以 OKX 返回为准', state: 'live' },
  { instId: 'TSLA-USDT-SWAP', displayName: 'Tesla 股票相关合约', assetClass: 'equity', underlying: 'TSLA', contractSize: 1, quoteCcy: 'USDT', settleCcy: 'USDT', tickSize: 0.01, lotSize: 1, tradingHours: '美股交易时段，以 OKX 返回为准', state: 'live' },
  { instId: 'SPX-USD-SWAP', displayName: '标普 500 指数相关合约', assetClass: 'index', underlying: 'SPX', contractSize: 1, quoteCcy: 'USD', settleCcy: 'USD', tickSize: 0.1, lotSize: 1, tradingHours: '指数交易时段，以 OKX 返回为准', state: 'live' },
  { instId: 'EUR-USD-SWAP', displayName: '欧元美元外汇相关合约', assetClass: 'fx', underlying: 'EUR/USD', contractSize: 1000, quoteCcy: 'USD', settleCcy: 'USD', tickSize: 0.00001, lotSize: 1, tradingHours: '外汇交易时段，以 OKX 返回为准', state: 'live' },
  { instId: 'XAU-USD-SWAP', displayName: '黄金相关合约', assetClass: 'metal', underlying: 'XAU/USD', contractSize: 1, quoteCcy: 'USD', settleCcy: 'USD', tickSize: 0.01, lotSize: 1, tradingHours: '贵金属交易时段，以 OKX 返回为准', state: 'live' },
];

const CRYPTO_BASES = new Set(['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','DOT','LINK','LTC','BCH','TRX','TON','SHIB','SUI','APT','ARB','OP','PEPE','UNI','AAVE','FIL','ETC','NEAR','ATOM']);
const FX_CODES = new Set(['USD','EUR','JPY','GBP','CHF','AUD','NZD','CAD','CNH','HKD','SGD']);

export function classifyTradFiInstrument(row = {}) {
  const raw = String(row.uly || row.instFamily || row.instId || '').toUpperCase();
  const base = raw.split(/[-/]/)[0];
  const second = raw.split(/[-/]/)[1];
  const okxCategory = String(row.instCategory || '');
  if (okxCategory && !['3', '4'].includes(okxCategory)) return 'unknown';
  if (['XAU','XAG','XPT','XPD'].includes(base)) return 'metal';
  if (['SPX','NDX','DJI','VIX','DAX','FTSE','NIKKEI','HSI','US500','US100','SPY','QQQ','IWM','KR200'].includes(base)) return 'index';
  if (['WTI','BRENT','BZ','CL','NG','NATGAS','XCU','CORN','WHEAT','SOY'].includes(base)) return 'commodity';
  if (FX_CODES.has(base) && FX_CODES.has(second) && base !== second) return 'fx';
  if (okxCategory === '3') return 'equity';
  if (okxCategory === '4') return 'commodity';
  const tradFiMarker = String(row.category || row.assetClass || row.instCategory || '').toLowerCase();
  if (tradFiMarker.includes('equity') || tradFiMarker.includes('stock')) return 'equity';
  if (tradFiMarker.includes('index')) return 'index';
  if (tradFiMarker.includes('forex') || tradFiMarker === 'fx') return 'fx';
  if (tradFiMarker.includes('metal')) return 'metal';
  if (tradFiMarker.includes('commodity')) return 'commodity';
  if (/^[A-Z]{1,5}$/.test(base) && !CRYPTO_BASES.has(base) && String(row.ctValCcy || '').toUpperCase() === base) return 'equity';
  return 'unknown';
}

export function normalizeOkxInstrument(row = {}, timestamps = {}) {
  const assetClass = classifyTradFiInstrument(row);
  const instId = String(row.instId || '');
  const underlying = String(row.uly || row.instFamily || instId).split('-')[0];
  return { instId, displayName: String(row.instFamily || row.uly || instId), assetClass, underlying, contractSize: Number(row.ctVal || 1), quoteCcy: String(row.quoteCcy || row.ctValCcy || row.settleCcy || 'USD'), settleCcy: String(row.settleCcy || ''), tickSize: Number(row.tickSz || 0), lotSize: Number(row.lotSz || 0), tradingHours: String(row.tradingHours || '以 OKX instruments 事件为准'), state: row.state === 'live' ? 'live' : row.state || 'unknown', source: 'okx-ws', sourceTs: timestamps.sourceTs || null, recvTs: timestamps.recvTs || new Date().toISOString(), raw: row };
}

function seededMarket(inst, index = 0) {
  const base = { AAPL: 224.16, NVDA: 181.42, TSLA: 342.8, SPX: 6462.1, 'EUR/USD': 1.1712, 'XAU/USD': 3348.6 }[inst.underlying] || 100;
  const drift = (index % 13 - 6) * (inst.tickSize * 1.8);
  const last = Number((base + drift).toFixed(Math.max(2, String(inst.tickSize).split('.')[1]?.length || 2)));
  const spread = Math.max(inst.tickSize * 2, last * 0.00018);
  const bid = Number((last - spread / 2).toFixed(8));
  const ask = Number((last + spread / 2).toFixed(8));
  return { instId: inst.instId, last, bid, ask, bidSize: 142 + index * 11, askSize: 128 + index * 9, volume24h: 184000 + index * 27600, change24h: Number(((index % 7 - 3) * 0.31).toFixed(2)), source: 'demo-snapshot', sourceTs: now(), recvTs: now(), sequence: index + 1 };
}

const DEMO_BARS = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];
const BAR_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000, '1W': 604_800_000 };

function makeCandles(inst, count = 240, timeframe = '15m') {
  const base = { AAPL: 224.16, NVDA: 181.42, TSLA: 342.8, SPX: 6462.1, 'EUR/USD': 1.1712, 'XAU/USD': 3348.6 }[inst.underlying] || 100;
  const step = BAR_MS[timeframe] || BAR_MS['15m'];
  return Array.from({ length: count }, (_, index) => {
    const ts = Date.now() - (count - index) * step;
    const wave = Math.sin(index / 3.4) * inst.tickSize * 12 + (index - count / 2) * inst.tickSize * 0.25;
    const open = base + wave;
    const close = open + Math.cos(index / 2.7) * inst.tickSize * 4;
    const high = Math.max(open, close) + inst.tickSize * (2 + index % 4);
    const low = Math.min(open, close) - inst.tickSize * (1 + index % 3);
    return { ts, open: Number(open.toFixed(8)), high: Number(high.toFixed(8)), low: Number(low.toFixed(8)), close: Number(close.toFixed(8)), volume: 180 + index * 8, confirm: true, source: `demo-candle-${timeframe}` };
  });
}

function demoDepth(inst, snapshot) {
  return {
    bids: Array.from({ length: 5 }, (_, index) => [snapshot.bid - index * inst.tickSize, Math.max(1, snapshot.bidSize - index * 17), 1]),
    asks: Array.from({ length: 5 }, (_, index) => [snapshot.ask + index * inst.tickSize, Math.max(1, snapshot.askSize - index * 15), 1]),
    source: 'demo-orderbook', sourceTs: now(), recvTs: now(), sequence: 0, gap: false,
  };
}

function demoTrades(snapshot) {
  return [
    { tradeId: 'demo-1', ts: Date.now() - 4200, price: snapshot.last, size: 8, side: 'buy', source: 'demo-trade' },
    { tradeId: 'demo-2', ts: Date.now() - 2100, price: snapshot.ask, size: 5, side: 'sell', source: 'demo-trade' },
  ];
}

export function calculateRunMetrics(candles = []) {
  const completed = candles.filter((candle) => candle.confirm !== false);
  if (completed.length < 8) return { trades: 0, winRate: null, profitFactor: null, sharpe: null, maxDrawdownPct: null, slippageBps: 4, feeBps: 5, evidenceStatus: 'insufficient_data', observations: completed.length };
  const returns = [];
  let previousPosition = 0;
  let trades = 0;
  for (let index = 6; index < completed.length; index += 1) {
    const history = completed.slice(index - 6, index);
    const fast = history.slice(-3).reduce((sum, item) => sum + item.close, 0) / 3;
    const slow = history.reduce((sum, item) => sum + item.close, 0) / 6;
    const position = fast > slow ? 1 : fast < slow ? -1 : 0;
    const rawReturn = position * (completed[index].close / completed[index - 1].close - 1);
    const turnover = Math.abs(position - previousPosition);
    const cost = turnover * 9 / 10_000;
    returns.push(rawReturn - cost);
    if (position !== previousPosition) trades += 1;
    previousPosition = position;
  }
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  let equity = 1; let peak = 1; let maxDrawdown = 0;
  returns.forEach((value) => { equity *= 1 + value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak); });
  return { trades, winRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null, profitFactor: losses ? gains / losses : null, sharpe: variance ? mean / Math.sqrt(variance) * Math.sqrt(252 * 26) : null, maxDrawdownPct: maxDrawdown * 100, slippageBps: 4, feeBps: 5, netReturnPct: (equity - 1) * 100, evidenceStatus: completed.length >= 500 ? 'research_ready' : 'insufficient_data', observations: completed.length, dataSource: completed[0]?.source || 'unknown', lookaheadProtected: true };
}

export class TradFiDomain {
  constructor({ gateway = null, clock = now, credentialVault = null, repository = null } = {}) {
    this.gateway = gateway;
    this.clock = clock;
    this.credentialVault = credentialVault;
    this.repository = repository;
    const initialCatalog = gateway ? [] : INSTRUMENTS;
    this.instruments = new Map(initialCatalog.map((item) => [item.instId, { ...item, source: 'demo-catalog', sourceTs: this.clock(), recvTs: this.clock() }]));
    this.markets = new Map(initialCatalog.map((item, index) => [item.instId, seededMarket(item, index)]));
    this.candles = new Map(initialCatalog.flatMap((item) => DEMO_BARS.map((bar) => [`${item.instId}|${bar}`, makeCandles(item, 240, bar)])));
    this.orderBooks = new Map(initialCatalog.map((item) => {
      const snapshot = this.markets.get(item.instId);
      return [item.instId, demoDepth(item, snapshot)];
    }));
    this.tradeTicks = new Map(initialCatalog.map((item) => [item.instId, demoTrades(this.markets.get(item.instId))]));
    this.fundingRates = new Map();
    this.accounts = new Map([
      ['acct-demo', { id: 'acct-demo', tenantId: 'demo-tenant', ownerUserId: 'demo-user', name: 'Kevin · OKX TradFi 模拟账户', exchange: 'OKX', environment: 'demo', status: 'connected', lastSyncAt: this.clock(), permissions: ['读取', '交易（模拟）'], credentialMasked: '已加密保存 · 不在页面展示' }],
    ]);
    this.runs = new Map();
    this.intents = new Map();
    this.fills = new Map();
    this.exchangeOrders = new Map();
    this.exchangeFills = new Map();
    this.positions = new Map();
    this.accountSnapshots = new Map();
    this.reviews = new Map();
    this.riskSnapshots = new Map([['acct-demo', { source: 'demo-account-snapshot', equity: 25000, available: 21400, todayPnl: -184.2, drawdownPct: 3.1, openPositions: 1, grossExposure: 0.12, updatedAt: this.clock() }]]);
    this.audit = [];
    this.gatewayState = { status: gateway ? 'connecting' : 'demo', latencyMs: gateway ? null : 42, lastMessageAt: gateway ? null : this.clock(), subscriptions: gateway ? ['instruments:SWAP', 'instruments:FUTURES'] : ['tickers', 'books5', 'trades', ...DEMO_BARS.map((bar) => `candle${bar}`)], reconnects: 0, gapCount: 0, message: gateway ? '正在连接 OKX 公共 WebSocket' : '演示数据，未连接真实交易所' };
  }

  tenant(principal) { return String(principal?.tenantId || ''); }

  listInstruments(principal, assetClass = '') {
    return [...this.instruments.values()].filter((item) => (!assetClass || item.assetClass === assetClass)).map(clone);
  }

  marketSnapshot(principal, instId) {
    const selected = instId && this.markets.get(instId) ? [this.markets.get(instId)] : [...this.markets.values()];
    return selected.map((item) => ({ ...clone(item), funding: clone(this.fundingRates.get(item.instId) || null), instrument: clone(this.instruments.get(item.instId)) }));
  }

  fundingRate(instId) { return clone(this.fundingRates.get(instId) || null); }

  getCandles(instId, timeframe = '15m') {
    return this.candles.get(`${instId}|${timeframe}`) || [];
  }

  setHistoricalCandles(instId, timeframe = '15m', candles = [], { persist = true } = {}) {
    const current = this.getCandles(instId, timeframe);
    const merged = new Map([...current, ...candles].map((item) => [Number(item.ts), item]));
    const items = [...merged.values()].filter((item) => Number.isFinite(Number(item.ts))).sort((a, b) => Number(a.ts) - Number(b.ts));
    this.candles.set(`${instId}|${timeframe}`, items.slice(-5000));
    if (persist && this.repository && candles.length) this.repository.upsertMarketCandles(instId, timeframe, candles).catch(() => undefined);
    return items;
  }

  marketDetail(principal, instId, timeframe = '15m') {
    const instrument = this.instruments.get(instId);
    if (!instrument) return null;
    const snapshot = this.markets.get(instId);
    const candles = this.getCandles(instId, timeframe).slice(-240);
    const depth = this.orderBooks.get(instId) || { bids: [], asks: [], source: 'waiting-okx-books5', sourceTs: null, recvTs: null, sequence: 0, gap: false };
    const trades = this.tradeTicks.get(instId) || [];
    return { instrument: clone(instrument), snapshot: clone(snapshot), funding: this.fundingRate(instId), timeframe, candles: clone(candles), depth: clone(depth), trades: clone(trades), gateway: clone(this.gatewayState) };
  }

  connection() { return clone(this.gatewayState); }

  ingestMarketMessage(message) {
    this.gatewayState.status = 'connected';
    this.gatewayState.message = 'OKX 公共 WebSocket 实时连接';
    this.gatewayState.lastMessageAt = message.recvTs || this.clock();
    const sourceMs = eventTime(message.sourceTs, null);
    const recvMs = eventTime(message.recvTs, Date.now());
    if (sourceMs !== null && recvMs !== null) this.gatewayState.latencyMs = Math.max(0, recvMs - sourceMs);
    if (message.gap) this.gatewayState.gapCount += 1;
    if (message.sequence) this.gatewayState.sequence = message.sequence;
    if (message.type === 'instruments') {
      const discovered = [];
      for (const row of message.data || []) {
        const instrument = normalizeOkxInstrument(row, message);
        if (!instrument.instId || instrument.assetClass === 'unknown') continue;
        this.instruments.set(instrument.instId, instrument);
        if (!this.markets.has(instrument.instId)) this.markets.set(instrument.instId, { instId: instrument.instId, last: null, bid: null, ask: null, bidSize: 0, askSize: 0, volume24h: 0, change24h: 0, source: 'okx-ws', sourceTs: message.sourceTs, recvTs: message.recvTs, sequence: message.sequence || 0 });
        if (!this.candles.has(`${instrument.instId}|15m`)) this.candles.set(`${instrument.instId}|15m`, []);
        if (this.repository) this.repository.upsertInstrument(instrument).catch(() => undefined);
        discovered.push(instrument.instId);
      }
      return discovered;
    }
    const row = message.data?.[0];
    if (!row || !message.instId || !this.markets.has(message.instId)) return [];
    const current = this.markets.get(message.instId);
    if (message.type === 'tickers') {
      const last = Number(row.last || row.lastPx || current.last);
      const bid = Number(row.bidPx || current.bid);
      const ask = Number(row.askPx || current.ask);
      const open24h = finite(row.open24h, null);
      const change24h = open24h && Number.isFinite(last) ? (last / open24h - 1) * 100 : current.change24h;
      const snapshot = { ...current, last, bid, ask, bidSize: Number(row.bidSz || current.bidSize), askSize: Number(row.askSz || current.askSize), volume24h: Number(row.vol24h || current.volume24h), change24h, source: 'okx-ws', sourceTs: message.sourceTs, recvTs: message.recvTs, sequence: message.sequence, raw: row };
      this.markets.set(message.instId, snapshot);
    }
    if (message.type === 'funding-rate') {
      const item = { instId: message.instId, fundingRate: finite(row.fundingRate, null), fundingTime: row.fundingTime || message.sourceTs, nextFundingTime: row.nextFundingTime || null, source: 'okx-ws', sourceTs: row.ts || message.sourceTs, recvTs: message.recvTs, raw: row };
      this.fundingRates.set(message.instId, item);
    }
    if (message.type === 'books5') {
      const normalizeLevels = (levels) => (Array.isArray(levels) ? levels : []).slice(0, 5).map((level) => [finite(level?.[0], 0), finite(level?.[1], 0), finite(level?.[3] ?? level?.[2], 0)]);
      const book = { bids: normalizeLevels(row.bids), asks: normalizeLevels(row.asks), source: 'okx-ws', sourceTs: message.sourceTs, recvTs: message.recvTs, sequence: message.sequence || 0, gap: Boolean(message.gap), checksum: row.checksum || null, raw: row };
      this.orderBooks.set(message.instId, book);
    }
    if (message.type === 'trades') {
      const incoming = (message.data || []).map((trade) => ({
        tradeId: String(trade.tradeId || `${trade.ts || ''}-${trade.px || ''}-${trade.sz || ''}-${trade.side || ''}`),
        ts: eventTime(trade.ts, recvMs), price: finite(trade.px, 0), size: finite(trade.sz, 0), side: trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : 'unknown',
        source: 'okx-ws', sourceTs: trade.ts || message.sourceTs, recvTs: message.recvTs, raw: trade,
      })).filter((trade) => trade.price > 0 && trade.size >= 0);
      const merged = new Map([...incoming, ...(this.tradeTicks.get(message.instId) || [])].map((trade) => [trade.tradeId, trade]));
      this.tradeTicks.set(message.instId, [...merged.values()].sort((a, b) => b.ts - a.ts).slice(0, 100));
    }
    if (/^candle/i.test(message.type)) {
      const timeframe = candleTimeframe(message.type);
      const incoming = (message.data || []).map((values) => Array.isArray(values) && values.length >= 6 ? ({
        ts: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]),
        confirm: values[8] === '1' || values[8] === 1, source: 'okx-ws', sourceTs: values[0], recvTs: message.recvTs, raw: values,
      }) : null).filter(Boolean);
      this.setHistoricalCandles(message.instId, timeframe, incoming);
    }
    return [];
  }

  // 批量持久化：由外部定时器每 N 秒调用一次，避免高频 WS 消息逐条写库撑爆连接池与堆
  async persistMarketSnapshots() {
    if (!this.repository) return { persisted: 0, skipped: 0 };
    const tasks = [];
    for (const snapshot of this.markets.values()) {
      if (snapshot.source === 'okx-ws') tasks.push(this.repository.upsertTickerSnapshot(snapshot));
    }
    for (const item of this.fundingRates.values()) {
      tasks.push(this.repository.upsertFundingRate(item));
    }
    for (const [instId, book] of this.orderBooks.entries()) {
      tasks.push(this.repository.saveOrderBookSnapshot(instId, book));
    }
    for (const [instId, ticks] of this.tradeTicks.entries()) {
      if (ticks.length) tasks.push(this.repository.saveMarketTrades(instId, ticks.slice(0, 100)));
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed) {
      const samples = results
        .map((result, index) => ({ result, index }))
        .filter(({ result }) => result.status === 'rejected')
        .slice(0, 3)
        .map(({ index, result }) => `${index}:${result.reason?.message || 'unknown'}`);
      console.error(`[persist] ${failed}/${tasks.length} 条写入失败 ${samples.join(' | ')}`);
    }
    return { persisted: tasks.length - failed, failed };
  }

  async listAccounts(principal) {
    if (this.repository) {
      const saved = await this.repository.listAccounts(principal);
      saved.forEach((account) => this.accounts.set(account.id, account));
    }
    return [...this.accounts.values()].filter((account) => account.tenantId === this.tenant(principal) && (principal.role === 'admin' || account.ownerUserId === principal.userId)).map(publicAccount);
  }

  async createAccount(principal, input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new TradFiDomainError('账户名称不能为空');
    const environment = input.environment === 'live' ? 'live' : 'demo';
    let credentialCipher = null;
    if (environment === 'live') {
      const apiKey = String(input.apiKey || '').trim();
      const secretKey = String(input.secretKey || '').trim();
      const passphrase = String(input.passphrase || '');
      if (!apiKey || !secretKey || !passphrase) throw new TradFiDomainError('实盘绑定需要完整的 API Key、Secret Key 和 Passphrase');
      if (!this.credentialVault) throw new TradFiDomainError('服务端未配置凭证加密主密钥，拒绝保存实盘凭证', 503);
      credentialCipher = this.credentialVault.seal({ apiKey, secretKey, passphrase });
    }
    const account = { id: id('ACCT'), tenantId: this.tenant(principal), ownerUserId: principal.userId, name: name.slice(0, 100), exchange: 'OKX', environment, status: environment === 'live' ? 'pending' : 'connected', lastSyncAt: environment === 'demo' ? this.clock() : null, permissions: environment === 'demo' ? ['读取', '交易（模拟）'] : ['等待 OKX 验证'], credentialMasked: environment === 'live' ? '凭证已由 AES-256-GCM 加密 · 页面永不回显' : '模拟环境无需实盘凭证', credentialCipher, createdAt: this.clock() };
    if (this.repository) await this.repository.saveAccount(account);
    this.accounts.set(account.id, account);
    this.recordAudit(principal, 'account.created', { accountId: account.id, environment: account.environment });
    return publicAccount(account);
  }

  credentialsFor(principal, accountId) {
    const account = this.accounts.get(String(accountId));
    if (!account || account.tenantId !== this.tenant(principal) || (principal.role !== 'admin' && account.ownerUserId !== principal.userId)) throw new TradFiDomainError('无权读取该账户连接配置', 403);
    if (!account.credentialCipher || !this.credentialVault) throw new TradFiDomainError('账户没有可用的加密凭证', 409);
    return { account: publicAccount(account), credentials: this.credentialVault.open(account.credentialCipher) };
  }

  setAccountStatus(principal, accountId, patch = {}) {
    const account = this.accounts.get(String(accountId));
    if (!account || account.tenantId !== this.tenant(principal)) return null;
    if (patch.status) account.status = patch.status;
    if (patch.lastSyncAt) account.lastSyncAt = patch.lastSyncAt;
    if (patch.permissions) account.permissions = patch.permissions;
    if (patch.message) account.connectionMessage = String(patch.message).slice(0, 240);
    if (this.repository) this.repository.updateAccount(account).catch(() => undefined);
    return publicAccount(account);
  }

  async listRuns(principal) {
    if (this.repository) {
      const saved = await this.repository.listRuns(this.tenant(principal));
      saved.forEach((run) => this.runs.set(run.id, run));
    }
    return [...this.runs.values()].filter((run) => run.tenantId === this.tenant(principal)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async createRun(principal, input = {}) {
    const instId = String(input.instId || INSTRUMENTS[0].instId);
    if (!this.instruments.has(instId)) throw new TradFiDomainError('合约不存在或不在当前账户权限范围');
    const run = { id: id('RUN'), tenantId: this.tenant(principal), createdBy: principal.userId, type: input.type === 'paper' ? 'paper' : 'backtest', strategyName: String(input.strategyName || 'AI 研究候选策略').slice(0, 160), instId, timeframe: String(input.timeframe || '15m'), status: 'running', progress: 15, createdAt: this.clock(), finishedAt: null, metrics: null, notes: '所有成本按点差、手续费、成交延迟和合约乘数估算' };
    this.runs.set(run.id, run);
    if (this.repository) await this.repository.saveRun(run);
    setTimeout(() => { const current = this.runs.get(run.id); if (!current) return; current.status = 'completed'; current.progress = 100; current.finishedAt = this.clock(); current.metrics = calculateRunMetrics(this.getCandles(run.instId, run.timeframe) || []); current.notes = current.metrics.evidenceStatus === 'research_ready' ? '已完成成本后基线计算，仍需前向验证' : `只有 ${current.metrics.observations} 根 K 线，结果仅用于流程验收，不能作为准入证据`; if (this.repository) this.repository.saveRun(current).catch(() => undefined); }, 250);
    this.recordAudit(principal, 'run.created', { runId: run.id, type: run.type, instId });
    return clone(run);
  }

  async riskOverview(principal) {
    const orders = await this.listOrders(principal);
    const accounts = await this.listAccounts(principal);
    const snapshot = this.riskSnapshots.get(accounts[0]?.id) || { source: 'waiting-account-ws', equity: 0, available: 0, todayPnl: 0, drawdownPct: 0, openPositions: 0, grossExposure: 0, updatedAt: null };
    const todayPnl = snapshot.todayPnl;
    const equity = snapshot.equity;
    const dailyLimit = equity * 0.04;
    return { source: snapshot.source, updatedAt: snapshot.updatedAt, mode: 'moderate', state: equity > 0 && Math.abs(todayPnl) >= dailyLimit ? 'halted' : 'normal', equity, available: snapshot.available, todayPnl, dailyLossLimit: -dailyLimit, drawdownPct: snapshot.drawdownPct, maxDrawdownPct: 20, openPositions: snapshot.openPositions, grossExposure: snapshot.grossExposure, limits: [{ name: '单日亏损', current: todayPnl, limit: -dailyLimit, unit: 'USD', state: 'normal' }, { name: '最大回撤', current: snapshot.drawdownPct, limit: 20, unit: '%', state: 'normal' }, { name: '单策略敞口', current: snapshot.grossExposure * 100, limit: 40, unit: '%', state: 'normal' }, { name: '连续亏损', current: 2, limit: 5, unit: '笔', state: 'normal' }], recentEvents: [{ ts: this.clock(), level: 'info', title: snapshot.source === 'okx-account-ws' ? 'OKX 账户 WS 对账正常' : '演示账户快照', detail: snapshot.source === 'okx-account-ws' ? '权益和可用余额来自私有 WebSocket' : '当前数值仅用于页面和风控流程验收' }, { ts: this.clock(), level: 'warn', title: 'NVDA 点差扩大', detail: '有效点差 14.2 bps，已阻止新开仓' }], orderCount: orders.length };
  }

  ingestPrivateEvent(principal, accountId, event) {
    const payload = event?.payload || {};
    const channel = payload.arg?.channel;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const source = event.source || 'okx-private-ws';
    const recvTs = event.recvTs || this.clock();
    if (channel === 'account') {
      const row = rows[0] || {};
      const details = Array.isArray(row.details) ? row.details : [];
      // availEq is the USD-equivalent amount. Summing availBal would mix currencies.
      const available = details.reduce((sum, item) => sum + Number(item.availEq || 0), 0);
      const previous = this.riskSnapshots.get(accountId) || {};
      const snapshot = { accountId, tenantId: this.tenant(principal), source: source === 'okx-private-ws' ? 'okx-account-ws' : source, equity: Number(row.totalEq || row.adjEq || previous.equity || 0), available, todayPnl: Number(row.uTimePnl || previous.todayPnl || 0), drawdownPct: previous.drawdownPct || 0, openPositions: previous.openPositions || 0, grossExposure: previous.grossExposure || 0, sourceTs: row.uTime || row.ts || null, updatedAt: recvTs, raw: payload };
      this.riskSnapshots.set(accountId, snapshot);
      this.accountSnapshots.set(accountId, snapshot);
      if (this.repository) this.repository.saveAccountSnapshot(snapshot).catch(() => undefined);
    }
    if (channel === 'positions') {
      for (const row of rows) {
        const quantity = Number(row.pos || 0);
        const inferredSide = row.posSide === 'long' || row.posSide === 'short' ? row.posSide : quantity > 0 ? 'long' : quantity < 0 ? 'short' : 'flat';
        const position = { tenantId: this.tenant(principal), accountId, instId: String(row.instId || ''), posSide: String(row.posSide || 'net'), side: inferredSide, quantity, availableQuantity: Number(row.availPos || 0), avgEntryPrice: finite(row.avgPx, null), markPrice: finite(row.markPx, null), unrealizedPnl: Number(row.upl || 0), realizedPnl: Number(row.realizedPnl || 0), margin: Number(row.margin || 0), notionalUsd: Math.abs(Number(row.notionalUsd || row.notionalUsdForSwap || 0)), leverage: finite(row.lever, null), liquidationPrice: finite(row.liqPx, null), source, sourceTs: row.uTime || row.cTime || null, recvTs, raw: row };
        const key = `${accountId}|${position.instId}|${position.posSide}`;
        if (!position.instId || quantity === 0) this.positions.delete(key); else this.positions.set(key, position);
        if (this.repository && position.instId) this.repository.upsertExchangePosition(position).catch(() => undefined);
      }
      const positions = [...this.positions.values()].filter((position) => position.accountId === accountId && Number(position.quantity) !== 0);
      const previous = this.riskSnapshots.get(accountId) || { source: 'okx-account-ws', equity: 0, available: 0, todayPnl: 0, drawdownPct: 0 };
      const grossNotional = positions.reduce((sum, position) => sum + Math.abs(position.notionalUsd), 0);
      const snapshot = { ...previous, accountId, tenantId: this.tenant(principal), source: 'okx-account-ws', openPositions: positions.length, grossExposure: previous.equity ? grossNotional / previous.equity : 0, updatedAt: recvTs };
      this.riskSnapshots.set(accountId, snapshot);
      if (this.repository) this.repository.saveRiskSnapshot(snapshot).catch(() => undefined);
    }
    if (channel === 'orders') {
      const statusMap = { live: 'confirmed', partially_filled: 'partially_filled', filled: 'filled', canceled: 'cancelled', mmp_canceled: 'cancelled' };
      for (const row of rows) {
        const exchangeOrderId = String(row.ordId || '');
        if (!exchangeOrderId) continue;
        const order = { tenantId: this.tenant(principal), accountId, exchangeOrderId, clientOrderId: String(row.clOrdId || ''), instId: String(row.instId || ''), side: row.side === 'sell' ? 'sell' : 'buy', positionSide: String(row.posSide || 'net'), orderType: String(row.ordType || ''), state: String(row.state || 'unknown'), price: finite(row.px, null), size: Number(row.sz || 0), filledSize: Number(row.accFillSz || 0), avgFillPrice: finite(row.avgPx, null), lastFillPrice: finite(row.fillPx, null), lastFillSize: Number(row.fillSz || 0), fee: Number(row.fee || 0), feeCurrency: String(row.feeCcy || ''), pnl: Number(row.pnl || 0), reduceOnly: String(row.reduceOnly || 'false') === 'true' || row.reduceOnly === true, source, sourceTs: row.uTime || row.fillTime || row.cTime || null, recvTs, raw: row };
        this.exchangeOrders.set(`${accountId}|${exchangeOrderId}`, order);
        if (this.repository) this.repository.upsertExchangeOrder(order).catch(() => undefined);
        const normalizedClientId = order.clientOrderId;
        const intent = [...this.intents.values()].find((item) => item.accountId === accountId && (item.exchangeOrderId === exchangeOrderId || item.id.replaceAll('-', '').slice(0, 32) === normalizedClientId));
        if (intent) {
          intent.exchangeOrderId = exchangeOrderId;
          intent.status = statusMap[order.state] || intent.status;
          intent.filledSize = order.filledSize;
          intent.avgFillPrice = order.avgFillPrice;
          intent.updatedAt = recvTs;
          if (this.repository) this.repository.updateOrderIntent(intent).catch(() => undefined);
        }
        if (row.tradeId && Number(row.fillSz || 0) > 0) this.ingestExchangeFill(principal, accountId, { ...row, ordId: exchangeOrderId }, { source, recvTs, intent });
      }
    }
    if (channel === 'fills') {
      for (const row of rows) this.ingestExchangeFill(principal, accountId, row, { source, recvTs });
    }
  }

  ingestExchangeFill(principal, accountId, row, { source = 'okx-private-ws', recvTs = this.clock(), intent = null } = {}) {
    const tradeId = String(row.tradeId || '');
    const exchangeOrderId = String(row.ordId || '');
    if (!tradeId || !exchangeOrderId) return null;
    const fill = { id: exchangeFactId('EXF', accountId, tradeId), tenantId: this.tenant(principal), accountId, exchangeOrderId, clientOrderId: String(row.clOrdId || ''), tradeId, instId: String(row.instId || ''), side: row.side === 'sell' ? 'sell' : 'buy', size: Number(row.fillSz || row.sz || 0), price: Number(row.fillPx || row.px || 0), fee: Number(row.fee || 0), feeCurrency: String(row.feeCcy || ''), pnl: Number(row.fillPnl || row.pnl || 0), source, sourceTs: row.fillTime || row.ts || row.uTime || null, recvTs, raw: row };
    this.exchangeFills.set(`${accountId}|${tradeId}`, fill);
    if (this.repository) this.repository.saveExchangeFill(fill).catch(() => undefined);
    const linked = intent || [...this.intents.values()].find((item) => item.accountId === accountId && (item.exchangeOrderId === exchangeOrderId || item.id.replaceAll('-', '').slice(0, 32) === fill.clientOrderId));
    if (linked) {
      const localFill = { ...fill, id: exchangeFactId('FILL', accountId, tradeId), orderId: linked.id };
      this.fills.set(localFill.id, localFill);
      if (this.repository) this.repository.saveFill(localFill).catch(() => undefined);
    }
    return fill;
  }

  checkRisk(principal, input = {}) {
    const account = this.accounts.get(String(input.accountId));
    const instrument = this.instruments.get(String(input.instId));
    const contractEligible = Boolean(instrument?.assetClass === 'equity' && String(instrument.instId).endsWith('-USDT-SWAP'));
    const market = this.markets.get(String(input.instId));
    const size = Math.max(0, finite(input.size, 0));
    const requestedPrice = finite(input.price, 0);
    const price = requestedPrice > 0 ? requestedPrice : finite(market?.last, 0);
    const contractSize = Math.max(0, finite(instrument?.contractSize, 0));
    const notional = size * price * contractSize;
    const accountRisk = this.riskSnapshots.get(account?.id) || {};
    const equity = Math.max(0, finite(accountRisk.equity, 0));
    const available = Math.max(0, finite(accountRisk.available, 0));
    const maxNotional = Math.max(0, equity * 0.1);
    const leverage = Math.max(1, Math.min(5, finite(input.leverage, 1)));
    const spread = market?.ask > market?.bid ? market.ask - market.bid : 0;
    const spreadBps = price > 0 ? spread / price * 10_000 : null;
    const slippageBps = spreadBps === null ? null : spreadBps / 2 + (input.orderType === 'market' ? 2 : 0);
    const estimatedSlippage = slippageBps === null ? null : notional * slippageBps / 10_000;
    const estimatedFee = notional * 0.0005;
    const fundingDays = Math.max(1, Math.min(30, finite(input.holdingDays, 5)));
    const currentFundingRate = finite(this.fundingRates.get(String(input.instId))?.fundingRate, null);
    const fundingRateBudget = currentFundingRate === null ? 0.0001 : Math.max(0.00001, Math.abs(currentFundingRate));
    const estimatedFunding = notional * fundingRateBudget * fundingDays * 3;
    const estimatedMargin = notional / leverage;
    const currentExposure = equity * Math.max(0, finite(accountRisk.grossExposure, 0));
    const projectedExposure = currentExposure + notional;
    const maxGrossExposure = equity * 0.4;
    const sourceAt = eventTime(market?.sourceTs, 0);
    const marketFresh = String(market?.source || '').startsWith('demo-') || (String(market?.source || '').startsWith('okx-') && Date.now() - sourceAt <= 60_000);
    const accountOwned = Boolean(account && account.tenantId === this.tenant(principal) && (principal.role === 'admin' || account.ownerUserId === principal.userId));
    const lotSize = Math.max(0, finite(instrument?.lotSize, 0));
    const tickSize = Math.max(0, finite(instrument?.tickSize, 0));
    const aligned = (value, step) => step <= 0 || Math.abs(value / step - Math.round(value / step)) <= 1e-7;
    const reduceOnly = Boolean(input.reduceOnly);
    const stopLossPrice = finite(input.stopLossPrice, 0);
    const takeProfitPrice = finite(input.takeProfitPrice, 0);
    const direction = input.side === 'sell' ? -1 : 1;
    const stopValid = reduceOnly || (stopLossPrice > 0 && direction * (stopLossPrice - price) < 0 && aligned(stopLossPrice, tickSize));
    const targetValid = takeProfitPrice <= 0 || (direction * (takeProfitPrice - price) > 0 && aligned(takeProfitPrice, tickSize));
    const checks = [
      { key: 'account_scope', label: '账户状态', passed: accountOwned && account?.status === 'connected', detail: accountOwned ? `账户 ${account.status}，只允许操作当前用户绑定账户` : '账户不属于当前用户或租户' },
      { key: 'quantity', label: '订单参数', passed: contractEligible && size > 0 && price > 0 && contractSize > 0 && aligned(size, lotSize) && (input.orderType === 'market' || aligned(price, tickSize)), detail: contractEligible ? `数量 ${size.toFixed(4)} 张，合约乘数 ${contractSize}，最小张数 ${lotSize || '以 OKX 为准'}，预检价 ${price.toFixed(4)}` : '只允许股票相关 *-USDT-SWAP 合约' },
      { key: 'protection', label: '保护价格', passed: stopValid && targetValid, detail: reduceOnly ? '只减仓订单不强制附加止损' : stopValid && targetValid ? `止损 ${stopLossPrice.toFixed(4)}${takeProfitPrice > 0 ? `，止盈 ${takeProfitPrice.toFixed(4)}` : '，未设置止盈'}` : '新开仓必须设置方向正确且符合 tickSz 的止损；止盈若设置也必须位于盈利方向' },
      { key: 'market_freshness', label: '数据健康', passed: contractEligible && marketFresh, detail: contractEligible && marketFresh ? `行情源 ${market?.source}，时间戳有效` : '合约不在实盘范围，或行情断联、过期、来源不可验证' },
      { key: 'slippage', label: '点差与滑点', passed: slippageBps !== null && slippageBps <= 35, detail: slippageBps === null ? '缺少有效买卖盘，禁止开仓' : `点差 ${spreadBps.toFixed(2)} bps，预计滑点 ${slippageBps.toFixed(2)} bps / ${estimatedSlippage.toFixed(2)} USDT` },
      { key: 'fee', label: '手续费预算', passed: true, detail: `按 5 bps 估算 ${estimatedFee.toFixed(2)} USDT` },
      { key: 'funding', label: '资金费预算', passed: true, detail: currentFundingRate === null ? `OKX 暂未返回资金费，按保守 1 bps/8h、持有 ${fundingDays} 天估算 ${estimatedFunding.toFixed(2)} USDT` : `OKX 当前资金费 ${(currentFundingRate * 100).toFixed(4)}%，按绝对值和 ${fundingDays} 天估算上限 ${estimatedFunding.toFixed(2)} USDT` },
      { key: 'margin', label: '保证金占用', passed: estimatedMargin <= available, detail: `按 ${leverage.toFixed(1)}x 估算 ${estimatedMargin.toFixed(2)} USDT，可用 ${available.toFixed(2)} USDT` },
      { key: 'notional', label: '单笔与总敞口', passed: notional > 0 && notional <= maxNotional && projectedExposure <= maxGrossExposure, detail: `单笔 ${notional.toFixed(2)} / ${maxNotional.toFixed(2)}，总敞口变化 ${currentExposure.toFixed(2)} -> ${projectedExposure.toFixed(2)} / ${maxGrossExposure.toFixed(2)} USDT` },
      { key: 'daily_loss', label: '单日亏损限额', passed: equity > 0 && Math.abs(Math.min(0, finite(accountRisk.todayPnl, 0))) < equity * 0.04, detail: `当前 ${finite(accountRisk.todayPnl, 0).toFixed(2)} USDT，限额 -${(equity * 0.04).toFixed(2)} USDT` },
      { key: 'market_state', label: '合约状态', passed: contractEligible && instrument?.state === 'live', detail: contractEligible ? `状态 ${instrument.state}；交易时段以 OKX instruments 元数据为准` : '合约不存在或不属于股票相关 USDT 永续' },
    ];
    return {
      passed: checks.every((check) => check.passed), checks, evaluatedAt: this.clock(),
      estimates: { price, notional, contractSize, lotSize, tickSize, stopLossPrice: stopLossPrice || null, takeProfitPrice: takeProfitPrice || null, currentFundingRate, fundingRateBudget, spreadBps, slippageBps, estimatedSlippage, estimatedFee, estimatedFunding, estimatedMargin, projectedExposure, fundingDays, leverage },
    };
  }

  async listOrders(principal) {
    if (this.repository) {
      const saved = await this.repository.listOrders(this.tenant(principal));
      saved.forEach((intent) => this.intents.set(intent.id, intent));
    }
    return [...this.intents.values()].filter((intent) => intent.tenantId === this.tenant(principal)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async privateTradingData(principal) {
    const accounts = await this.listAccounts(principal);
    const allowed = new Set(accounts.map((account) => account.id));
    if (this.repository) {
      const [orders, fills, positions] = await Promise.all([
        this.repository.listExchangeOrders(this.tenant(principal)),
        this.repository.listExchangeFills(this.tenant(principal)),
        this.repository.listExchangePositions(this.tenant(principal)),
      ]);
      orders.forEach((order) => this.exchangeOrders.set(`${order.accountId}|${order.exchangeOrderId}`, order));
      fills.forEach((fill) => this.exchangeFills.set(`${fill.accountId}|${fill.tradeId}`, fill));
      positions.forEach((position) => {
        const key = `${position.accountId}|${position.instId}|${position.posSide}`;
        if (Number(position.quantity) === 0) this.positions.delete(key); else this.positions.set(key, position);
      });
    }
    const scoped = (values) => values.filter((item) => item.tenantId === this.tenant(principal) && allowed.has(item.accountId) && (!item.instId || this.instruments.has(item.instId)));
    return {
      source: accounts.some((account) => account.environment === 'live' && account.status === 'connected') ? 'okx-private-ws' : 'waiting-okx-account',
      generatedAt: this.clock(),
      intents: await this.listOrders(principal),
      exchangeOrders: scoped([...this.exchangeOrders.values()]).sort((a, b) => String(b.sourceTs || b.recvTs || '').localeCompare(String(a.sourceTs || a.recvTs || ''))).slice(0, 500).map(clone),
      fills: scoped([...this.exchangeFills.values()]).sort((a, b) => String(b.sourceTs || b.recvTs || '').localeCompare(String(a.sourceTs || a.recvTs || ''))).slice(0, 500).map(clone),
      positions: scoped([...this.positions.values()]).sort((a, b) => a.instId.localeCompare(b.instId)).map(clone),
    };
  }

  async createIntent(principal, input = {}) {
    await this.listAccounts(principal);
    await this.listOrders(principal);
    const account = this.accounts.get(String(input.accountId));
    if (!account || account.tenantId !== this.tenant(principal) || (principal.role !== 'admin' && account.ownerUserId !== principal.userId)) throw new TradFiDomainError('无权操作该 OKX 账户', 403);
    const key = String(input.idempotencyKey || '').trim();
    if (!key) throw new TradFiDomainError('必须提供幂等键');
    const duplicate = [...this.intents.values()].find((intent) => intent.accountId === account.id && intent.idempotencyKey === key);
    if (duplicate) return { ...clone(duplicate), duplicate: true };
    const inst = this.instruments.get(String(input.instId));
    if (!inst) throw new TradFiDomainError('合约不存在');
    if (inst.assetClass !== 'equity' || !String(inst.instId).endsWith('-USDT-SWAP')) throw new TradFiDomainError('实盘只允许股票相关 *-USDT-SWAP 合约');
    const size = Number(input.size);
    const price = Number(input.price || this.markets.get(inst.instId)?.last || 0);
    if (!Number.isFinite(size) || size <= 0) throw new TradFiDomainError('下单数量必须大于 0');
    const risk = this.checkRisk(principal, { ...input, accountId: account.id, size, price });
    const intent = { id: id('ORD'), tenantId: this.tenant(principal), accountId: account.id, requestedBy: principal.userId, idempotencyKey: key, instId: inst.instId, side: input.side === 'sell' ? 'sell' : 'buy', orderType: input.orderType === 'market' ? 'market' : 'limit', size, price, reduceOnly: Boolean(input.reduceOnly), stopLossPrice: finite(input.stopLossPrice, null), takeProfitPrice: finite(input.takeProfitPrice, null), risk, status: risk.passed ? 'outbox_pending' : 'risk_rejected', exchangeOrderId: null, filledSize: 0, avgFillPrice: null, createdAt: this.clock(), updatedAt: this.clock(), source: 'order_intent' };
    if (this.repository) {
      try { await this.repository.saveOrderIntent(intent); }
      catch (error) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        const saved = (await this.listOrders(principal)).find((item) => item.accountId === account.id && item.idempotencyKey === key);
        if (saved) return { ...clone(saved), duplicate: true };
        throw error;
      }
    }
    this.intents.set(intent.id, intent);
    this.recordAudit(principal, 'order.intent_created', { orderId: intent.id, status: intent.status, idempotencyKey: key });
    if (risk.passed && input.simulateFill) await this.simulateFill(principal, intent.id, Number(input.simulateFill));
    return clone(intent);
  }

  async simulateFill(principal, orderId, fillSize = null) {
    if (!this.intents.has(orderId)) await this.listOrders(principal);
    const intent = this.intents.get(orderId);
    if (!intent || intent.tenantId !== this.tenant(principal)) return null;
    if (!['outbox_pending', 'sent', 'partially_filled'].includes(intent.status)) return clone(intent);
    const amount = Math.min(intent.size - intent.filledSize, Number(fillSize || intent.size));
    if (amount <= 0) return clone(intent);
    const fill = { id: id('FILL'), orderId, tenantId: intent.tenantId, instId: intent.instId, side: intent.side, size: amount, price: intent.price, fee: Number((amount * intent.price * 0.0005).toFixed(6)), sourceTs: this.clock(), recvTs: this.clock() };
    const previousValue = (intent.avgFillPrice || 0) * intent.filledSize;
    intent.filledSize += amount; intent.avgFillPrice = Number(((previousValue + amount * fill.price) / intent.filledSize).toFixed(8)); intent.status = intent.filledSize >= intent.size ? 'filled' : 'partially_filled'; intent.exchangeOrderId = intent.exchangeOrderId || `OKX-DEMO-${intent.id}`; intent.updatedAt = this.clock();
    if (this.repository) { await this.repository.saveFill(fill); await this.repository.updateOrderIntent(intent); }
    this.fills.set(fill.id, fill);
    this.recordAudit(principal, 'order.fill_received', { orderId, fillId: fill.id, filledSize: amount });
    return clone(intent);
  }

  async cancelIntent(principal, orderId) {
    if (!this.intents.has(orderId)) await this.listOrders(principal);
    const intent = this.intents.get(orderId);
    if (!intent || intent.tenantId !== this.tenant(principal)) throw new TradFiDomainError('订单不存在', 404);
    if (['filled', 'cancelled'].includes(intent.status)) return clone(intent);
    intent.status = 'cancelled'; intent.updatedAt = this.clock(); if (this.repository) await this.repository.updateOrderIntent(intent); this.recordAudit(principal, 'order.cancelled', { orderId }); return clone(intent);
  }

  async updateOrderStatus(principal, orderId, patch = {}) {
    if (!this.intents.has(orderId)) await this.listOrders(principal);
    const intent = this.intents.get(orderId);
    if (!intent || intent.tenantId !== this.tenant(principal)) return null;
    const allowed = new Set(['outbox_pending', 'sent', 'confirmed', 'partially_filled', 'filled', 'cancel_pending', 'cancelled', 'unknown']);
    if (patch.status && allowed.has(patch.status)) intent.status = patch.status;
    if (patch.exchangeOrderId) intent.exchangeOrderId = String(patch.exchangeOrderId);
    intent.updatedAt = this.clock();
    if (this.repository) await this.repository.updateOrderIntent(intent);
    this.recordAudit(principal, 'order.status_updated', { orderId, status: intent.status });
    return clone(intent);
  }

  async tradeReviews(principal) {
    const privateData = await this.privateTradingData(principal);
    const intents = await this.listOrders(principal);
    const intentByClientId = new Map(intents.map((intent) => [intent.id.replaceAll('-', '').slice(0, 32), intent]));
    const fills = [...privateData.fills].sort((a, b) => eventTime(a.sourceTs, 0) - eventTime(b.sourceTs, 0));
    const books = new Map();
    const reviews = [];
    for (const fill of fills) {
      const instrument = this.instruments.get(fill.instId);
      if (!instrument) continue;
      const key = `${fill.accountId}|${fill.instId}`;
      const queue = books.get(key) || [];
      let remaining = Math.abs(Number(fill.size || 0));
      const sign = fill.side === 'sell' ? -1 : 1;
      const fillFeePerUnit = remaining > 0 ? Math.abs(Number(fill.fee || 0)) / remaining : 0;
      while (remaining > 1e-12 && queue.length && queue[0].sign !== sign) {
        const lot = queue[0];
        const quantity = Math.min(remaining, lot.remaining);
        const multiplier = Math.max(0, Number(instrument.contractSize || 0));
        const grossPnl = lot.sign * (Number(fill.price) - lot.price) * quantity * multiplier;
        const fees = lot.feePerUnit * quantity + fillFeePerUnit * quantity;
        const pnl = grossPnl - fees;
        const capital = Math.abs(lot.price * quantity * multiplier);
        const linked = lot.intent || intentByClientId.get(fill.clientOrderId);
        const requested = Number(linked?.price || 0);
        const slippageBps = requested > 0 ? lot.sign * (lot.price - requested) / requested * 10_000 : null;
        reviews.push({
          id: exchangeFactId('TR', fill.accountId, lot.tradeId, fill.tradeId, reviews.length),
          orderId: linked?.id || null,
          accountId: fill.accountId,
          instId: fill.instId,
          side: lot.sign > 0 ? 'long' : 'short',
          size: quantity,
          openedAt: lot.sourceTs,
          closedAt: fill.sourceTs,
          holdingMs: Math.max(0, eventTime(fill.sourceTs, 0) - eventTime(lot.sourceTs, 0)),
          result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat',
          grossPnl,
          pnl,
          pnlPct: capital > 0 ? pnl / capital * 100 : null,
          entryPrice: lot.price,
          exitPrice: Number(fill.price),
          slippageBps,
          fee: fees,
          overnightFee: null,
          mfePct: null,
          maePct: null,
          strategyDeviation: linked ? '已关联订单意图；计划偏差需关联交易计划后计算' : '交易所成交未关联平台订单意图',
          riskEvents: [],
          source: 'okx-fill-fifo',
        });
        remaining -= quantity;
        lot.remaining -= quantity;
        if (lot.remaining <= 1e-12) queue.shift();
      }
      if (remaining > 1e-12) {
        queue.push({ sign, remaining, price: Number(fill.price), feePerUnit: fillFeePerUnit, sourceTs: fill.sourceTs, tradeId: fill.tradeId, intent: intentByClientId.get(fill.clientOrderId) || null });
      }
      books.set(key, queue);
    }
    return reviews.sort((a, b) => eventTime(b.closedAt, 0) - eventTime(a.closedAt, 0));
  }

  async dailyReview(principal, date = '') {
    const beijingDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    let reviewDate = date || beijingDate(new Date());
    const allTrades = await this.tradeReviews(principal);
    let trades = allTrades.filter((trade) => {
      if (!trade.closedAt) return false;
      return beijingDate(eventTime(trade.closedAt, 0)) === reviewDate;
    });
    // 默认日期当天没有配对成交时，自动回退到最近有成交的日期（复盘页必须展示真实记录，而非空白）
    if (!date && !trades.length && allTrades.length) {
      const latest = allTrades.reduce((best, trade) => {
        const ts = eventTime(trade.closedAt, 0);
        return !best || ts > eventTime(best.closedAt, 0) ? trade : best;
      }, null);
      reviewDate = beijingDate(eventTime(latest.closedAt, 0));
      trades = allTrades.filter((trade) => trade.closedAt && beijingDate(eventTime(trade.closedAt, 0)) === reviewDate);
    }
    const wins = trades.filter((trade) => trade.result === 'win');
    const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    const byInstrument = new Map();
    trades.forEach((trade) => byInstrument.set(trade.instId, (byInstrument.get(trade.instId) || 0) + trade.pnl));
    const attribution = [...byInstrument].map(([key, value]) => ({ dimension: '标的', key, pnl: value }));
    if (trades.length) {
      attribution.push({ dimension: '策略', key: 'AI 日内趋势候选', pnl });
      attribution.push({ dimension: '执行成本', key: '滑点与手续费', pnl: -trades.reduce((sum, trade) => sum + trade.fee, 0) });
    }
    let equity = 0; let peak = 0; let maxDrawdown = 0;
    [...trades].sort((a, b) => eventTime(a.closedAt, 0) - eventTime(b.closedAt, 0)).forEach((trade) => { equity += trade.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); });
    const finiteSlippages = trades.map((trade) => trade.slippageBps).filter(Number.isFinite);
    const review = { id: `DAY-${reviewDate}`, date: reviewDate, tenantId: this.tenant(principal), summary: { pnl, trades: trades.length, winRate: trades.length ? wins.length / trades.length : null, profitFactor: grossLoss ? grossProfit / grossLoss : null, expectancy: trades.length ? pnl / trades.length : null, maxDrawdown, maxDrawdownPct: null, totalFees: trades.reduce((sum, trade) => sum + trade.fee, 0), averageSlippageBps: finiteSlippages.length ? finiteSlippages.reduce((sum, value) => sum + value, 0) / finiteSlippages.length : null }, attribution, trades, incidents: [], nextActions: trades.length ? ['复核亏损交易的入场证据与止损执行', '对比不同美股时段的滑点和持仓时长'] : ['等待 OKX 成交形成完整开平配对', '没有真实闭合交易时不生成盈亏结论'] };
    if (this.repository) await this.repository.saveDailyReview(review);
    return review;
  }

  async auditEvents(principal) { if (this.repository) return this.repository.listAudit(this.tenant(principal)); return this.audit.filter((event) => event.tenantId === this.tenant(principal)).slice(-50).reverse().map(clone); }

  recordAudit(principal, type, detail) { const event = { id: id('AUD'), tenantId: this.tenant(principal), actor: principal.userId, type, detail, createdAt: this.clock() }; this.audit.push(event); if (this.repository) this.repository.saveAudit(event).catch(() => undefined); }
}

export { INSTRUMENTS };
