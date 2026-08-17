import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIResearchService,
  InMemoryResearchRepository,
  MockResearchProvider,
  ResearchValidationError,
  validateResearchRequest,
} from '../backend/ai-research.mjs';

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

test('AI 研究流水线生成候选，但不会直接授予实盘资格', async () => {
  const repository = new InMemoryResearchRepository();
  const service = new AIResearchService({
    repository,
    provider: new MockResearchProvider(),
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
  const service = new AIResearchService({ repository, provider: new MockResearchProvider(), instrumentCatalog: { discover: async (scope) => scope } });
  const job = await service.start({ tenantId: 'tenant-b', userId: 'user-b', input: validInput });
  await service.run(job.id);
  const candidate = await repository.getCandidate((await repository.getJob(job.id)).candidateId);
  assert.equal(candidate.tenantId, 'tenant-b');
  assert.equal(candidate.status, 'research_only');
});
