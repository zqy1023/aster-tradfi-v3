// 策略管理：内置策略目录 + 启用/停用 + 运行统计
// 策略定义与信号引擎共享同一套 type 标识（见 workstation-domain.mjs buildSignals）

const DEFAULT_STRATEGIES = [
  {
    key: 'breakout_retest',
    name: '突破回踩确认',
    style: 'breakout_retest',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '4H',
    hypothesis: '日线突破 20 日区间边界后不立即追价，等待 4H 回踩确认支撑/压力后入场，降低假突破损耗。',
    entryRule: '突破 20 日边界 + 4H 回踩至突破位 1ATR 内企稳',
    exitRule: '突破位下方 1.2ATR 止损，目标 2R',
    status: 'enabled',
  },
  {
    key: 'momentum_follow',
    name: '动量延续跟随',
    style: 'momentum_follow',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '4H',
    hypothesis: '价格沿 EMA20 斜率方向连续创新高/新低，ADX 强劲表明趋势未衰竭，顺势跟随强势标的。',
    entryRule: 'EMA20 斜率同向 + 创 10 日新高/低 + ADX14≥20',
    exitRule: 'EMA20 反向跌破/升破离场',
    status: 'enabled',
  },
  {
    key: 'range_mean',
    name: '区间高抛低吸',
    style: 'range_mean',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '4H',
    hypothesis: 'ADX 低迷、价格在 20 日区间中部震荡时，在区间 20%/80% 分位反向操作，捕捉无趋势行情的高抛低吸。',
    entryRule: 'ADX14<16 + 价格触及区间 20%/80% 分位 + RSI 极值',
    exitRule: '区间中线或 1ATR 止损',
    status: 'disabled',
  },
];

export class StrategyManager {
  constructor({ repository = null, clock = () => new Date() } = {}) {
    this.repository = repository;
    this.clock = clock;
    this.catalog = new Map(DEFAULT_STRATEGIES.map((item) => [item.key, { ...item }]));
    if (this.repository) this.seed().catch((error) => console.error('[strategy-manager] seed 失败', error.message));
  }

  async seed() {
    const tasks = [];
    for (const item of this.catalog.values()) {
      tasks.push(this.repository.upsertStrategy({
        key: item.key,
        tenantId: '1',
        name: item.name,
        style: item.style,
        assetClass: item.assetClass,
        primaryTimeframe: item.primaryTimeframe,
        confirmationTimeframe: item.confirmationTimeframe,
        hypothesis: item.hypothesis,
        status: item.status,
        createdBy: '1',
      }).catch(() => undefined));
    }
    await Promise.allSettled(tasks);
  }

  async list(principal) {
    const rows = await this.repository?.listStrategies(this.tenant(principal)).catch(() => []) || [];
    const saved = new Map(rows.map((row) => [row.key, row]));
    const strategies = [];
    for (const item of this.catalog.values()) {
      const row = saved.get(item.key);
      strategies.push({
        key: item.key,
        name: item.name,
        style: item.style,
        assetClass: item.assetClass,
        primaryTimeframe: item.primaryTimeframe,
        confirmationTimeframe: item.confirmationTimeframe,
        hypothesis: item.hypothesis,
        entryRule: item.entryRule,
        exitRule: item.exitRule,
        status: row ? row.status : item.status,
        enabled: row ? row.status === 'enabled' : item.status === 'enabled',
        updatedAt: row?.updatedAt || null,
      });
    }
    return strategies;
  }

  async setEnabled(principal, key, enabled) {
    if (!this.catalog.has(key)) throw new Error('策略不存在');
    if (this.catalog.get(key).style === 'range_mean' && enabled === false) {
      // 允许关闭；打开时要求数据积累提示由前端处理
    }
    const row = await this.repository?.upsertStrategy({
      key,
      tenantId: this.tenant(principal),
      name: this.catalog.get(key).name,
      style: this.catalog.get(key).style,
      assetClass: this.catalog.get(key).assetClass,
      primaryTimeframe: this.catalog.get(key).primaryTimeframe,
      confirmationTimeframe: this.catalog.get(key).confirmationTimeframe,
      hypothesis: this.catalog.get(key).hypothesis,
      status: enabled ? 'enabled' : 'disabled',
      updatedAt: this.clock().toISOString(),
    }).catch(() => null);
    return { key, enabled, row };
  }

  catalogForSignalEngine() {
    return this.catalog;
  }

  tenant(principal) {
    return String(principal?.tenantId || '1');
  }
}
