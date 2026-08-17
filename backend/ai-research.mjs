export const RESEARCH_STAGES = Object.freeze([
  '目标解析',
  '合约发现',
  '研究假设',
  '策略规格',
  '历史回测',
  '前向滚动验证',
  '压力测试',
  '研究结论',
]);

const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const ALLOWED_MODES = new Set(['research', 'paper']);

export class ResearchValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ResearchValidationError';
    this.details = details;
  }
}

export function validateResearchRequest(input = {}) {
  const objective = String(input.objective || '').trim();
  if (objective.length < 12 || objective.length > 2000) {
    throw new ResearchValidationError('研究目标需要 12-2000 个字符', { field: 'objective' });
  }

  const assetScope = Array.isArray(input.assetScope)
    ? input.assetScope.map((value) => String(value).trim()).filter(Boolean).slice(0, 100)
    : [];
  if (assetScope.length === 0) {
    throw new ResearchValidationError('至少选择一个 TradFi 合约范围', { field: 'assetScope' });
  }

  const timeframe = String(input.timeframe || '15m');
  if (!ALLOWED_TIMEFRAMES.has(timeframe)) {
    throw new ResearchValidationError('时间周期不受支持', { field: 'timeframe' });
  }

  const maxRiskBps = Number(input.maxRiskBps ?? 50);
  const maxDrawdownBps = Number(input.maxDrawdownBps ?? 1000);
  const capital = Number(input.capital ?? 0);
  if (!Number.isFinite(maxRiskBps) || maxRiskBps < 1 || maxRiskBps > 500) {
    throw new ResearchValidationError('单笔最大风险必须在 1-500 个基点之间', { field: 'maxRiskBps' });
  }
  if (!Number.isFinite(maxDrawdownBps) || maxDrawdownBps < 100 || maxDrawdownBps > 5000) {
    throw new ResearchValidationError('最大回撤阈值必须在 100-5000 个基点之间', { field: 'maxDrawdownBps' });
  }
  if (!Number.isFinite(capital) || capital <= 0) {
    throw new ResearchValidationError('研究资金必须大于 0', { field: 'capital' });
  }

  const mode = String(input.mode || 'research');
  if (!ALLOWED_MODES.has(mode)) {
    throw new ResearchValidationError('研究模式不受支持', { field: 'mode' });
  }

  return Object.freeze({
    objective,
    assetScope,
    timeframe,
    maxRiskBps,
    maxDrawdownBps,
    capital,
    holdingPeriod: String(input.holdingPeriod || '日内，收盘前平仓').slice(0, 120),
    constraints: String(input.constraints || '不使用未来数据；考虑点差、滑点、手续费、融资和交易时段').slice(0, 1000),
    mode,
  });
}

function nowIso(clock) {
  return (clock?.() || new Date()).toISOString();
}

function makeId(prefix, clock) {
  const stamp = nowIso(clock).replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCandidate(candidate, request) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const performance = source.performance && typeof source.performance === 'object' ? source.performance : {};
  return {
    name: String(source.name || 'AI TradFi 合约策略候选').slice(0, 160),
    hypothesis: String(source.hypothesis || request.objective).slice(0, 2000),
    style: String(source.style || '日内趋势').slice(0, 80),
    entryRules: Array.isArray(source.entryRules) ? source.entryRules.map(String).slice(0, 20) : [],
    exitRules: Array.isArray(source.exitRules) ? source.exitRules.map(String).slice(0, 20) : [],
    filters: Array.isArray(source.filters) ? source.filters.map(String).slice(0, 20) : [],
    sizing: String(source.sizing || `单笔风险不超过 ${request.maxRiskBps} bps，按合约乘数与保证金约束换算`).slice(0, 600),
    costs: Array.isArray(source.costs) ? source.costs.map(String).slice(0, 20) : [
      '盘口有效半点差',
      '成交规模与盘口深度影响',
      'OKX 交易手续费',
      '融资、隔夜和展期费用',
    ],
    performance: {
      trades: finiteOrNull(performance.trades),
      oosSharpe: finiteOrNull(performance.oosSharpe),
      profitFactor: finiteOrNull(performance.profitFactor),
      maxDrawdownBps: finiteOrNull(performance.maxDrawdownBps),
      winRate: finiteOrNull(performance.winRate),
    },
    limitations: Array.isArray(source.limitations) ? source.limitations.map(String).slice(0, 20) : [],
  };
}

export class OpenAICompatibleResearchProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-5' } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.name = 'openai-compatible';
  }

  async generateCandidate(request, context = {}) {
    if (!this.apiKey) throw new Error('AI_PROVIDER_API_KEY 未配置');
    const system = [
      '你是 TradFi 合约量化研究员。只研究 OKX 股票、指数、外汇、贵金属和大宗商品相关合约。',
      '必须使用可证伪、逐条可执行的规则；禁止使用未来数据；必须考虑交易时段、点差、滑点、手续费、融资、隔夜和展期费用。',
      '只输出 JSON，不要 Markdown。字段：name,hypothesis,style,entryRules[],exitRules[],filters[],sizing,costs[],performance{trades,oosSharpe,profitFactor,maxDrawdownBps,winRate},limitations[]。',
    ].join(' ');
    const user = JSON.stringify({ request, instruments: context.instruments || [] });
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!response.ok) throw new Error(`AI 服务返回 ${response.status}`);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (!text) throw new Error('AI 服务没有返回研究结果');
    return JSON.parse(text);
  }
}

export class InMemoryResearchRepository {
  constructor() {
    this.jobs = new Map();
    this.events = new Map();
    this.candidates = new Map();
  }

  async createJob(job) { this.jobs.set(job.id, structuredClone(job)); this.events.set(job.id, []); return job; }
  async updateJob(id, patch) { const next = { ...this.jobs.get(id), ...patch }; this.jobs.set(id, structuredClone(next)); return next; }
  async getJob(id) { return this.jobs.get(id) || null; }
  async listJobs(tenantId, limit = 20) { return [...this.jobs.values()].filter((job) => String(job.tenantId) === String(tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(structuredClone); }
  async addEvent(id, event) { const items = this.events.get(id) || []; items.push(structuredClone(event)); this.events.set(id, items); return event; }
  async getEvents(id) { return structuredClone(this.events.get(id) || []); }
  async saveCandidate(candidate) { this.candidates.set(candidate.id, structuredClone(candidate)); return candidate; }
  async getCandidate(id) { return this.candidates.get(id) || null; }
}

export class AIResearchService {
  constructor({ repository, provider, instrumentCatalog, clock } = {}) {
    this.repository = repository || new InMemoryResearchRepository();
    this.provider = provider || null;
    this.instrumentCatalog = instrumentCatalog || { discover: async (scope) => scope };
    this.clock = clock;
  }

  async start({ tenantId, userId, input }) {
    if (!this.provider) throw new ResearchValidationError('AI 研究未配置：需要设置 AI_PROVIDER=openai-compatible 及对应模型参数');
    const request = validateResearchRequest(input);
    const job = {
      id: makeId('AIR', this.clock),
      tenantId: String(tenantId),
      userId: String(userId),
      status: 'queued',
      provider: this.provider.name,
      request,
      currentStage: RESEARCH_STAGES[0],
      progress: 0,
      createdAt: nowIso(this.clock),
      completedAt: null,
      failureReason: null,
    };
    await this.repository.createJob(job);
    await this.record(job.id, '任务已创建', { mode: request.mode, provider: this.provider.name });
    queueMicrotask(() => this.run(job.id).catch(() => undefined));
    return job;
  }

  async run(id) {
    const job = await this.repository.getJob(id);
    if (!job || job.status === 'completed') return job;
    try {
      await this.repository.updateJob(id, { status: 'running' });
      await this.stage(id, 0, '目标解析', { objective: job.request.objective, constraints: job.request.constraints });
      const instruments = await this.instrumentCatalog.discover(job.request.assetScope);
      await this.stage(id, 1, '合约发现', { instruments: instruments.slice(0, 100) });
      const candidate = normalizeCandidate(await this.provider.generateCandidate(job.request, { instruments }), job.request);
      const candidateRecord = { id: makeId('STR', this.clock), jobId: id, tenantId: job.tenantId, createdBy: job.userId, status: 'research_only', version: 1, spec: candidate, createdAt: nowIso(this.clock) };
      await this.repository.saveCandidate(candidateRecord);
      await this.stage(id, 2, '研究假设', { hypothesis: candidate.hypothesis });
      await this.stage(id, 3, '策略规格', { entryRules: candidate.entryRules, exitRules: candidate.exitRules, filters: candidate.filters, sizing: candidate.sizing });
      await this.stage(id, 4, '历史回测', { status: 'queued', requirement: '使用 OKX TradFi 历史逐笔/盘口和交易时段数据' });
      await this.stage(id, 5, '前向滚动验证', { status: 'queued', method: 'rolling, purged, embargo' });
      await this.stage(id, 6, '压力测试', { status: 'queued', scenarios: ['点差扩大 2 倍', '成交延迟 500 ms', '流动性下降 50%', '交易时段提前结束'] });
      await this.stage(id, 7, '研究结论', { status: 'needs_validation', candidateId: candidateRecord.id });
      await this.repository.updateJob(id, { status: 'completed', currentStage: '研究结论', progress: 100, completedAt: nowIso(this.clock), candidateId: candidateRecord.id });
      await this.record(id, 'AI 已生成研究候选，等待数据验证和人工审批', { candidateId: candidateRecord.id, liveTradingAllowed: false });
      return this.repository.getJob(id);
    } catch (error) {
      await this.repository.updateJob(id, { status: 'failed', failureReason: error.message, completedAt: nowIso(this.clock) });
      await this.record(id, '研究任务失败', { reason: error.message });
      throw error;
    }
  }

  async stage(id, index, name, details) {
    await this.repository.updateJob(id, { currentStage: name, progress: Math.round((index / (RESEARCH_STAGES.length - 1)) * 100) });
    const message = details?.status === 'queued' ? `阶段已排队：${name}` : `阶段完成：${name}`;
    await this.record(id, message, details);
  }

  async record(id, message, details) {
    return this.repository.addEvent(id, { id: makeId('EVT', this.clock), jobId: id, message, details, createdAt: nowIso(this.clock) });
  }
}
