import test from 'node:test';
import assert from 'node:assert/strict';
import { TradFiDomain, calculateRunMetrics, classifyTradFiInstrument, normalizeOkxInstrument } from '../backend/tradfi-domain.mjs';
import { OKXMarketGateway } from '../backend/okx-market-gateway.mjs';
import { OKXPrivateGateway } from '../backend/okx-private-gateway.mjs';
import { CredentialVault } from '../backend/credential-vault.mjs';
import { MySQLTradFiRepository } from '../backend/mysql-tradfi-repository.mjs';
import { buildWorkstationSnapshot } from '../backend/workstation-domain.mjs';

const admin = { tenantId: 'demo-tenant', userId: 'demo-user', role: 'admin' };
const otherTenant = { tenantId: 'tenant-other', userId: 'user-other', role: 'admin' };

// 测试注入：向空 domain 写入真实格式的 AAPL 合约、行情与 K 线（替代已删除的 demo 数据）
function seedTestDomain(domain, { candlesPerBar = 240 } = {}) {
  const recvTs = '2026-08-16T00:00:00.000Z';
  domain.ingestMarketMessage({ type: 'instruments', sourceTs: '1000', recvTs, data: [{ instId: 'AAPL-USDT-SWAP', uly: 'AAPL-USDT', instCategory: '3', ctValCcy: 'AAPL', state: 'live', tickSz: '0.01', lotSz: '0.01' }] });
  domain.ingestMarketMessage({ type: 'tickers', instId: 'AAPL-USDT-SWAP', sourceTs: String(Date.now()), recvTs, data: [{ last: '224.16', bidPx: '224.1', askPx: '224.2', bidSz: '12', askSz: '9', open24h: '220', vol24h: '1000' }] });
  const stepMs = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000, '1W': 604_800_000 };
  for (const [bar, step] of Object.entries(stepMs)) {
    const candles = Array.from({ length: candlesPerBar }, (_, index) => ({
      ts: 1_700_000_000_000 - (candlesPerBar - index) * step,
      open: 220 + index * 0.01, high: 226 + index * 0.01, low: 218 + index * 0.01, close: 224 + index * 0.01,
      volume: 1000 + index, confirm: true, source: 'okx-rest-history',
    }));
    domain.setHistoricalCandles('AAPL-USDT-SWAP', bar, candles, { persist: false });
  }
  domain.accounts.set('acct-demo', { id: 'acct-demo', tenantId: 'demo-tenant', ownerUserId: 'demo-user', name: '测试账户', exchange: 'OKX', environment: 'demo', status: 'connected', lastSyncAt: recvTs, permissions: ['读取'], credentialMasked: '已加密保存 · 不在页面展示' });
  domain.riskSnapshots.set('acct-demo', { source: 'okx-account-ws', equity: 26000, available: 21000, todayPnl: 0, drawdownPct: 0, openPositions: 0, grossExposure: 0, updatedAt: recvTs });
}

test('行情详情包含合约元数据、已确认 K 线、盘口和连接来源', () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  const detail = domain.marketDetail(admin, 'AAPL-USDT-SWAP');
  assert.equal(detail.instrument.assetClass, 'equity');
  assert.equal(detail.candles.length, 240);
  assert.equal(detail.candles.every((item) => item.confirm === true), true);
  assert.equal(detail.depth.bids.length, 0);
  assert.equal(detail.gateway.status, 'connected');
});

test('OKX 合约目录只接纳可明确识别的 TradFi 标的', () => {
  assert.equal(classifyTradFiInstrument({ instId: 'BTC-USDT-SWAP', uly: 'BTC-USDT' }), 'unknown');
  assert.equal(classifyTradFiInstrument({ instId: 'OKB-USDT-SWAP', uly: 'OKB-USDT', instCategory: '1', ctValCcy: 'OKB' }), 'unknown');
  assert.equal(classifyTradFiInstrument({ instId: 'AAPL-USDT-SWAP', uly: 'AAPL-USDT', instCategory: '3', ctValCcy: 'AAPL' }), 'equity');
  assert.equal(classifyTradFiInstrument({ instId: 'CL-USDT-SWAP', uly: 'CL-USDT', instCategory: '4', ctValCcy: 'CL' }), 'commodity');
  assert.equal(classifyTradFiInstrument({ instId: 'XAU-USD-SWAP', uly: 'XAU-USD' }), 'metal');
  assert.equal(classifyTradFiInstrument({ instId: 'EUR-USD-SWAP', uly: 'EUR-USD' }), 'fx');
  assert.equal(classifyTradFiInstrument({ instId: 'AAPL-USD-SWAP', category: 'equity', ctValCcy: 'AAPL' }), 'equity');
  const instrument = normalizeOkxInstrument({ instId: 'SPX-USD-SWAP', uly: 'SPX-USD', ctVal: '1', tickSz: '0.1', lotSz: '1', state: 'live' }, { recvTs: '2026-08-16T00:00:00.000Z' });
  assert.equal(instrument.assetClass, 'index');
  assert.equal(instrument.contractSize, 1);
  assert.equal(instrument.source, 'okx-ws');
});

test('机会雷达只接纳股票相关 USDT 永续合约', () => {
  const instruments = [
    { instId: 'AAPL-USDT-SWAP', underlying: 'AAPL', displayName: 'Apple', assetClass: 'equity', tickSize: 0.01 },
    { instId: 'SPCX-USD_UM_XPERP-310613', underlying: 'SPCX', displayName: 'SPCX', assetClass: 'equity', tickSize: 0.01 },
    { instId: 'XAU-USDT-SWAP', underlying: 'XAU', displayName: 'Gold', assetClass: 'metal', tickSize: 0.01 },
  ];
  const marketItems = instruments.map((instrument, index) => ({ instId: instrument.instId, last: 100 + index, bid: 99.9 + index, ask: 100.1 + index, volume24h: 10_000_000 - index, instrument }));
  const snapshot = buildWorkstationSnapshot({ instruments, marketItems, connection: { status: 'connected', lastMessageAt: new Date().toISOString() }, liveTrading: true });
  assert.deepEqual(snapshot.opportunities.map((item) => item.instId), ['AAPL-USDT-SWAP']);
  assert.equal(snapshot.marketState.breadth.equities, 1);
  assert.equal(snapshot.execution.liveTrading, true);
  assert.equal(snapshot.mode, 'live-data-live-execution');
});

test('回测指标由已完成 K 线计算并标记数据充分性', () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({ close: 100 + Math.sin(index / 3) + index * 0.05, confirm: true, source: 'test-candles' }));
  const metrics = calculateRunMetrics(candles);
  const withOpenCandle = calculateRunMetrics([...candles, { close: 1_000_000, confirm: false, source: 'okx-ws' }]);
  assert.equal(metrics.observations, 30);
  assert.equal(withOpenCandle.observations, 30);
  assert.equal(withOpenCandle.netReturnPct, metrics.netReturnPct);
  assert.equal(metrics.lookaheadProtected, true);
  assert.equal(metrics.evidenceStatus, 'insufficient_data');
  assert.equal(metrics.dataSource, 'test-candles');
  assert.ok(Number.isFinite(metrics.maxDrawdownPct));
});

test('候选使用已确认 K 线且计划缺失时仍显示最佳策略触发距离', () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  const instrument = domain.instruments.get('AAPL-USDT-SWAP');
  const market = domain.markets.get('AAPL-USDT-SWAP');
  const confirmed = domain.getCandles('AAPL-USDT-SWAP', '1D');
  const baseline = buildWorkstationSnapshot({
    instruments: [instrument],
    marketItems: [{ ...market, instrument }],
    candleSets: { [instrument.instId]: { '1D': confirmed, '4H': domain.getCandles(instrument.instId, '4H') } },
    connection: { status: 'connected', lastMessageAt: new Date().toISOString() },
  }).opportunities[0];
  const withOpenCandle = buildWorkstationSnapshot({
    instruments: [instrument],
    marketItems: [{ ...market, instrument }],
    candleSets: { [instrument.instId]: { '1D': [...confirmed, { ...confirmed.at(-1), ts: Date.now(), close: 1_000_000, confirm: false }], '4H': domain.getCandles(instrument.instId, '4H') } },
    connection: { status: 'connected', lastMessageAt: new Date().toISOString() },
  }).opportunities[0];
  assert.ok(baseline.trigger.distancePct === null || Number.isFinite(baseline.trigger.distancePct));
  assert.match(baseline.trigger.label, /参考位|入场区|等待/);
  assert.deepEqual(withOpenCandle.signals, baseline.signals);
  assert.deepEqual(withOpenCandle.plan, baseline.plan);
});

test('账户列表和订单操作按租户与所有者隔离', async () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  assert.equal((await domain.listAccounts(admin)).length, 1);
  assert.equal((await domain.listAccounts(otherTenant)).length, 0);
  await assert.rejects(() => domain.createIntent(otherTenant, {
    accountId: 'acct-demo', instId: 'AAPL-USDT-SWAP', size: 1, price: 224, idempotencyKey: 'cross-tenant',
  }), /无权操作/);
});

test('订单意图执行风险检查并用幂等键阻止重复订单', async () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  const first = await domain.createIntent(admin, { accountId: 'acct-demo', instId: 'AAPL-USDT-SWAP', side: 'buy', size: 1, price: 224.16, stopLossPrice: 215, takeProfitPrice: 240, idempotencyKey: 'idem-1' });
  const duplicate = await domain.createIntent(admin, { accountId: 'acct-demo', instId: 'AAPL-USDT-SWAP', side: 'buy', size: 1, price: 224.16, stopLossPrice: 215, takeProfitPrice: 240, idempotencyKey: 'idem-1' });
  const rejected = await domain.createIntent(admin, { accountId: 'acct-demo', instId: 'AAPL-USDT-SWAP', side: 'buy', size: 100, price: 224.16, idempotencyKey: 'idem-2' });
  assert.equal(first.status, 'outbox_pending');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(rejected.status, 'risk_rejected');
  assert.equal((await domain.listOrders(admin)).length, 2);
});

test('实盘订单接口拒绝非股票 USDT 永续合约', async () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  domain.instruments.set('SPCX-USD_UM_XPERP-310613', { instId: 'SPCX-USD_UM_XPERP-310613', assetClass: 'equity', state: 'live' });
  domain.markets.set('SPCX-USD_UM_XPERP-310613', { instId: 'SPCX-USD_UM_XPERP-310613', last: 20, bid: 19.99, ask: 20.01, source: 'okx-ws', sourceTs: String(Date.now()) });
  await assert.rejects(
    () => domain.createIntent(admin, { accountId: 'acct-demo', instId: 'SPCX-USD_UM_XPERP-310613', side: 'buy', size: 1, price: 20, idempotencyKey: 'out-of-scope' }),
    /只允许股票相关/,
  );
});

test('七个决策周期都有独立 K 线且预检返回交易成本估算', () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  for (const bar of ['1m', '5m', '15m', '1H', '4H', '1D', '1W']) {
    const candles = domain.getCandles('AAPL-USDT-SWAP', bar);
    assert.equal(candles.length, 240);
    assert.equal(candles[0].source, 'okx-rest-history');
  }
  const risk = domain.checkRisk(admin, { accountId: 'acct-demo', instId: 'AAPL-USDT-SWAP', side: 'buy', orderType: 'market', size: 1, price: 0, stopLossPrice: 215, takeProfitPrice: 240, holdingDays: 5, leverage: 1 });
  assert.equal(risk.passed, true);
  assert.ok(risk.estimates.price > 0);
  assert.ok(risk.estimates.estimatedFee > 0);
  assert.ok(risk.estimates.estimatedFunding > 0);
  assert.ok(risk.estimates.estimatedMargin > 0);
  assert.equal(risk.checks.some((check) => check.key === 'market_freshness'), true);
  assert.equal(risk.checks.some((check) => check.key === 'slippage'), true);
});

test('成交后生成单笔和单日复盘，归因来自真实成交合约', async () => {
  const clock = () => '2026-08-17T08:30:00.000Z';
  const domain = new TradFiDomain({ clock, gateway: true });
  seedTestDomain(domain);
  domain.ingestPrivateEvent(admin, 'acct-demo', { source: 'okx-rest-reconcile', recvTs: clock(), payload: { arg: { channel: 'fills' }, data: [
    { ordId: 'O-OPEN', tradeId: 'F-OPEN', instId: 'AAPL-USDT-SWAP', side: 'buy', fillPx: '224', fillSz: '2', fee: '-0.2', fillTime: String(Date.parse('2026-08-17T07:00:00.000Z')) },
    { ordId: 'O-CLOSE', tradeId: 'F-CLOSE', instId: 'AAPL-USDT-SWAP', side: 'sell', fillPx: '226', fillSz: '2', fee: '-0.2', fillTime: String(Date.parse('2026-08-17T08:00:00.000Z')) },
  ] } });
  const trades = await domain.tradeReviews(admin);
  const daily = await domain.dailyReview(admin);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].instId, 'AAPL-USDT-SWAP');
  assert.equal(trades[0].source, 'okx-fill-fifo');
  assert.equal(trades[0].pnl, 3.6);
  assert.equal(daily.summary.trades, 1);
  assert.equal(daily.attribution.some((item) => item.dimension === '标的' && item.key === 'AAPL-USDT-SWAP'), true);
  assert.equal(daily.summary.profitFactor, null);
});

test('OKX WebSocket 消息解析保留时间戳、序列并识别断档', () => {
  const events = [];
  const gateway = new OKXMarketGateway({ WebSocketImpl: class {}, onMessage: (event) => events.push(event) });
  gateway.handleMessage(JSON.stringify({ arg: { channel: 'books', instId: 'AAPL-USD-SWAP' }, data: [{ bids: [], asks: [], ts: '1000', seqId: '10' }] }));
  gateway.handleMessage(JSON.stringify({ arg: { channel: 'books', instId: 'AAPL-USD-SWAP' }, data: [{ bids: [], asks: [], ts: '1001', seqId: '12' }] }));
  gateway.handleMessage(JSON.stringify({ arg: { channel: 'candle15m', instId: 'AAPL-USD-SWAP' }, data: [['900000', '1', '2', '0.5', '1.5', '10']] }));
  assert.equal(events[0].sourceTs, '1000');
  assert.equal(events[0].sequence, 10);
  assert.equal(events[1].gap, true);
  assert.ok(events[1].recvTs);
  assert.equal(events[2].sourceTs, '900000');
});

test('实盘行情直接保存 OKX 五档和逐笔，当前 K 线按时间戳更新而不重复', () => {
  const domain = new TradFiDomain({ gateway: true });
  const recvTs = '2026-08-16T00:00:01.000Z';
  domain.ingestMarketMessage({ type: 'instruments', sourceTs: '1000', recvTs, data: [{ instId: 'AAPL-USDT-SWAP', uly: 'AAPL-USDT', instCategory: '3', ctValCcy: 'AAPL', state: 'live', tickSz: '0.01', lotSz: '0.01' }] });
  domain.ingestMarketMessage({ type: 'tickers', instId: 'AAPL-USDT-SWAP', sourceTs: '1000', recvTs, data: [{ last: '225.1', bidPx: '225.0', askPx: '225.2', bidSz: '12', askSz: '9', open24h: '220', vol24h: '1000' }] });
  domain.ingestMarketMessage({ type: 'books5', instId: 'AAPL-USDT-SWAP', sourceTs: '1001', recvTs, sequence: 9, data: [{ bids: [['225.0', '12', '0', '3'], ['224.9', '8', '0', '2']], asks: [['225.2', '9', '0', '4']] }] });
  domain.ingestMarketMessage({ type: 'trades', instId: 'AAPL-USDT-SWAP', sourceTs: '1002', recvTs, data: [{ tradeId: 'T-1', px: '225.2', sz: '2', side: 'buy', ts: '1002' }] });
  domain.ingestMarketMessage({ type: 'funding-rate', instId: 'AAPL-USDT-SWAP', sourceTs: '1003', recvTs, data: [{ fundingRate: '0.0001', fundingTime: '1003', nextFundingTime: '2003', ts: '1003' }] });
  domain.ingestMarketMessage({ type: 'candle15m', instId: 'AAPL-USDT-SWAP', sourceTs: '900000', recvTs, data: [['900000', '224', '226', '223', '225', '100', '0', '0', '0']] });
  domain.ingestMarketMessage({ type: 'candle15m', instId: 'AAPL-USDT-SWAP', sourceTs: '900000', recvTs, data: [['900000', '224', '227', '223', '226', '120', '0', '0', '0']] });
  const detail = domain.marketDetail(admin, 'AAPL-USDT-SWAP', '15m');
  assert.deepEqual(detail.depth.bids[0], [225, 12, 3]);
  assert.equal(detail.depth.bids.length, 2);
  assert.equal(detail.trades[0].tradeId, 'T-1');
  assert.equal(detail.funding.fundingRate, 0.0001);
  assert.equal(detail.candles.length, 1);
  assert.equal(detail.candles[0].high, 227);
  assert.equal(detail.candles[0].close, 226);
});

test('OKX 私有订单、成交和持仓按账户保存并只返回 TradFi 合约', async () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  domain.ingestPrivateEvent(admin, 'acct-demo', { source: 'okx-private-ws', recvTs: '2026-08-16T00:00:02.000Z', payload: { arg: { channel: 'orders' }, data: [{ ordId: 'O-1', clOrdId: 'external', instId: 'AAPL-USDT-SWAP', side: 'buy', ordType: 'limit', state: 'partially_filled', px: '224', sz: '2', accFillSz: '1', avgPx: '223.9', fillPx: '223.9', fillSz: '1', tradeId: 'F-1', fillTime: '1002' }, { ordId: 'O-CRYPTO', instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', state: 'live', sz: '1' }] } });
  domain.ingestPrivateEvent(admin, 'acct-demo', { source: 'okx-private-ws', recvTs: '2026-08-16T00:00:03.000Z', payload: { arg: { channel: 'positions' }, data: [{ instId: 'AAPL-USDT-SWAP', posSide: 'net', pos: '2', avgPx: '224', markPx: '225', upl: '2', notionalUsd: '450' }] } });
  const data = await domain.privateTradingData(admin);
  assert.equal(data.exchangeOrders.length, 1);
  assert.equal(data.exchangeOrders[0].exchangeOrderId, 'O-1');
  assert.equal(data.fills[0].tradeId, 'F-1');
  assert.equal(data.positions[0].instId, 'AAPL-USDT-SWAP');
});

test('实盘账户凭证必须加密保存且不会通过账户接口回显', async () => {
  const plainDomain = new TradFiDomain();
  await assert.rejects(() => plainDomain.createAccount(admin, { name: '实盘', environment: 'live', apiKey: 'key', secretKey: 'secret', passphrase: 'pass' }), /加密主密钥/);
  const vault = new CredentialVault('this-is-a-test-key-with-32-characters');
  const domain = new TradFiDomain({ credentialVault: vault });
  const account = await domain.createAccount(admin, { name: '隔离实盘', environment: 'live', apiKey: 'api-key', secretKey: 'secret-key', passphrase: 'passphrase' });
  assert.equal(account.status, 'pending');
  assert.equal('credentialCipher' in account, false);
  assert.equal(JSON.stringify(await domain.listAccounts(admin)).includes('secret-key'), false);
  const stored = domain.credentialsFor(admin, account.id);
  assert.deepEqual(stored.credentials, { apiKey: 'api-key', secretKey: 'secret-key', passphrase: 'passphrase' });
});

test('OKX 私有 WebSocket 使用交易所要求的签名并默认未连接', () => {
  const gateway = new OKXPrivateGateway({ credentials: { apiKey: 'api-key', secretKey: 'secret-key', passphrase: 'passphrase' }, accountId: 'account-1' });
  const args = gateway.loginArgs();
  assert.equal(args.apiKey, 'api-key');
  assert.equal(args.passphrase, 'passphrase');
  assert.ok(args.sign.length > 20);
  assert.equal(gateway.status, 'disconnected');
});

test('实盘订单发送合约保护价，并适配双向持仓模式', async () => {
  let sentBody;
  const gateway = new OKXPrivateGateway({ credentials: { apiKey: 'api-key', secretKey: 'secret-key', passphrase: 'passphrase' }, accountId: 'account-1', fetchImpl: async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { json: async () => ({ code: '0', data: [{ sCode: '0', ordId: 'OKX-1' }] }) };
  } });
  gateway.status = 'connected';
  gateway.accountConfig = { posMode: 'long_short_mode' };
  const pending = await gateway.placeOrder({ id: 'ORD123', instId: 'AAPL-USDT-SWAP', side: 'buy', orderType: 'limit', size: 1, price: 224, reduceOnly: false, stopLossPrice: 215, takeProfitPrice: 240 });
  assert.equal(sentBody.posSide, 'long');
  assert.equal(sentBody.attachAlgoOrds[0].slTriggerPx, '215');
  assert.equal(sentBody.attachAlgoOrds[0].tpTriggerPx, '240');
  assert.equal(pending[0].ordId, 'OKX-1');
});

test('OKX 私有账户事件更新风险权益来源', async () => {
  const domain = new TradFiDomain({ gateway: true });
  seedTestDomain(domain);
  domain.ingestPrivateEvent(admin, 'acct-demo', { recvTs: '2026-08-16T00:00:00.000Z', payload: { arg: { channel: 'account' }, data: [{ totalEq: '26000', details: [{ availEq: '21000' }] }] } });
  const risk = await domain.riskOverview(admin);
  assert.equal(risk.source, 'okx-account-ws');
  assert.equal(risk.equity, 26000);
  assert.equal(risk.available, 21000);
});

test('MySQL 订单意图和 Outbox 在同一事务提交', async () => {
  const statements = [];
  const connection = { beginTransaction: async () => statements.push('BEGIN'), execute: async (sql) => statements.push(sql), commit: async () => statements.push('COMMIT'), rollback: async () => statements.push('ROLLBACK'), release: () => statements.push('RELEASE') };
  const repository = new MySQLTradFiRepository({ getConnection: async () => connection });
  await repository.saveOrderIntent({ id: 'ORD-1', tenantId: '1', accountId: 'ACCT-1', requestedBy: '1', idempotencyKey: 'idem', instId: 'AAPL-USD-SWAP', side: 'buy', orderType: 'limit', size: 1, price: 224, reduceOnly: false, risk: { passed: true }, status: 'outbox_pending', exchangeOrderId: null, filledSize: 0, avgFillPrice: null, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z' });
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.some((sql) => String(sql).includes('INSERT INTO order_intents')), true);
  assert.equal(statements.some((sql) => String(sql).includes('INSERT INTO order_outbox')), true);
  assert.equal(statements.includes('COMMIT'), true);
  assert.equal(statements.includes('ROLLBACK'), false);
});

test('MySQL 历史 K 线读取使用服务端约束的 LIMIT 整数', async () => {
  let statement = '';
  let values = [];
  const repository = new MySQLTradFiRepository({ execute: async (sql, params) => { statement = sql; values = params; return [[]]; } });
  await repository.loadMarketCandles('AAPL-USDT-SWAP', '15m', 999999);
  assert.match(statement, /LIMIT 5000$/);
  assert.equal(statement.includes('LIMIT ?'), false);
  assert.deepEqual(values, ['AAPL-USDT-SWAP', '15m']);
});
