import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIResearchService,
  InMemoryResearchRepository,
  ResearchValidationError,
  validateResearchRequest,
} from '../backend/ai-research.mjs';

// 测试专用假 provider（替代已删除的 MockResearchProvider，仅用于流水线逻辑测试）
class FakeResearchProvider {
  name = 'fake';
  async generateCandidate(request) {
    return {
      name: `${request.assetScope[0]} AI 趋势候选`,
      hypothesis: '测试假设：趋势延续概率高于随机基线。',
      style: '趋势跟随',
      entryRules: ['仅在已完成 K 线收盘后生成信号'],
      exitRules: ['2ATR 止损'],
      filters: ['单合约敞口不超过账户权益 10%'],
      sizing: `每笔风险上限 ${request.maxRiskBps} bps`,
      performance: { trades: null, oosSharpe: null, profitFactor: null, maxDrawdownBps: null, winRate: null },
      limitations: ['测试数据，非交易建议'],
    };
  }
}

const validInput = {
  objective: '研究美国大型科技股合约在开盘后趋势延续机会，要求日内平仓并控制回撤',
  assetScope: ['美国股票合约'],
  timeframe: '15m',
  maxRiskBps: 50,
  maxDrawdownBps: 1000,
  capital: 25000,
};

test('研究请求必须具备目标、TradFi 范围和风险边界', () => {
  const request = validateResearchRequest(validInput);
  assert.equal(request.timeframe, '15m');
  assert.equal(request.maxRiskBps, 50);
  assert.throws(() => validateResearchRequest({ ...validInput, objective: '太短' }), ResearchValidationError);
  assert.throws(() => validateResearchRequest({ ...validInput, assetScope: [] }), ResearchValidationError);
  assert.throws(() => validateResearchRequest({ ...validInput, maxRiskBps: 0 }), ResearchValidationError);
});

test('未配置 AI provider 时研究任务被拒绝', async () => {
  const service = new AIResearchService({ repository: new InMemoryResearchRepository() });
  await assert.rejects(() => service.start({ tenantId: 'tenant-a', userId: 'user-a', input: validInput }), /AI 研究未配置/);
});

test('AI 研究流水线生成候选，但不会直接授予实盘资格', async () => {
  const repository = new InMemoryResearchRepository();
  const service = new AIResearchService({
    repository,
    provider: new FakeResearchProvider(),
    instrumentCatalog: { discover: async (scope) => scope.map((instId) => ({ instId, state: 'live' })) },
  });
  const job = await service.start({ tenantId: 'tenant-a', userId: 'user-a', input: validInput });
  await service.run(job.id);
  const saved = await repository.getJob(job.id);
  const candidate = await repository.getCandidate(saved.candidateId);
  const events = await repository.getEvents(job.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.progress, 100);
  assert.equal(candidate.status, 'research_only');
  assert.equal(candidate.spec.entryRules.length > 0, true);
  assert.equal(candidate.spec.performance.oosSharpe, null);
  assert.equal(candidate.spec.performance.trades, null);
  assert.equal(events.some((event) => event.message === '阶段已排队：前向滚动验证'), true);
  assert.equal(events.at(-1).details.liveTradingAllowed, false);
});

test('研究任务按租户保存，候选需要显式进入模拟', async () => {
  const repository = new InMemoryResearchRepository();
  const service = new AIResearchService({ repository, provider: new FakeResearchProvider(), instrumentCatalog: { discover: async (scope) => scope } });
  const job = await service.start({ tenantId: 'tenant-b', userId: 'user-b', input: validInput });
  await service.run(job.id);
  const candidate = await repository.getCandidate((await repository.getJob(job.id)).candidateId);
  assert.equal(candidate.tenantId, 'tenant-b');
  assert.equal(candidate.status, 'research_only');
});
