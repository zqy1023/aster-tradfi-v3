import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketEventService } from '../backend/market-events.mjs';

test('事件服务筛选美国高影响宏观事件和候选股票财报', async () => {
  const saved = [];
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => String(url).includes('faireconomy')
      ? [{ title: 'CPI m/m', country: 'USD', date: '2026-08-18T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '0.3%' }, { title: 'Low event', country: 'USD', date: '2026-08-18T09:00:00-04:00', impact: 'Low' }]
      : { data: { rows: [{ symbol: 'AAPL', name: 'Apple Inc', time: 'After Hours', epsForecast: '1.2' }, { symbol: 'MSFT', name: 'Microsoft', time: 'Before Hours' }] } },
  });
  const service = new MarketEventService({ fetchImpl, repository: { saveMarketEvents: async (events) => saved.push(...events) }, clock: () => new Date('2026-08-17T00:00:00.000Z') });
  const result = await service.load(['AAPL']);
  assert.equal(result.state, 'live');
  assert.equal(result.macro.length, 1);
  // 现在返回全部财报（不再过滤，7天×2行=14），earningsMatched 给出候选池匹配
  assert.equal(result.earnings.length, 14);
  assert.equal(result.earningsMatched.every((event) => event.symbol === 'AAPL'), true);
  assert.equal(saved.some((event) => event.symbol === 'MSFT'), true);
});
