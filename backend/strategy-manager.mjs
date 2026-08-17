// 策略管理：内置策略目录 + 启用/停用
// 基于因子研究(FACTOR_RESEARCH_20260817.md)的结论：
//   方向因子(技术指标)无稳定alpha → 删除旧3策略(突破回踩/动量延续/区间高抛低吸)
//   横截面12月动量 Sharpe 1.42 有效 → 动量选股
//   波动率预测 IC 0.3-0.4 稳定 → 波动率目标仓位(风控层)

const DEFAULT_STRATEGIES = [
  {
    key: 'momentum_select',
    name: '12月动量选股',
    style: 'momentum_select',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '1W',
    hypothesis: '每月末按过去12个月收益率对全市场美股永续排序，做多动量最强的 Top3-5 并持有到下月。横截面动量是学术最稳健的因子之一，回测年化 73%、Sharpe 1.42（美股5年代理数据）。',
    entryRule: '每月末：过去12月收益率 Top3-5 标的，次月首个交易日开盘等权买入',
    exitRule: '月末重新排序换仓；跌破 20 日 EMA 或周线 Donchian55 下沿提前退出',
    status: 'disabled',
    evidence: '2021-08~2026-08 美股12标的代理: 年化73.2% Sharpe 1.42, 仅2022年-18%(详见 docs/FACTOR_RESEARCH_20260817.md)',
  },
  {
    key: 'vol_target',
    name: '波动率目标仓位',
    style: 'vol_target',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '4H',
    hypothesis: '用 ATR14% 预测未来波动率（预测 IC 0.28-0.41，分年度稳定），高波动时自动减仓、低波动时满仓，把组合波动压到目标水平。回测 Sharpe 0.414→0.559、回撤 64.7%→36.8%。',
    entryRule: '仓位 = 目标年化波动30% / 当前ATR14%年化预测；波动飙升时(财报/宏观前)提示减仓',
    exitRule: '每日按最新预测波动调整仓位；ATR% > 均值1.5倍时强制降至半仓',
    status: 'disabled',
    evidence: '波动率预测 IC 分年度全正; VolTarget 10/12标的Sharpe提升(详见 docs/FACTOR_RESEARCH_20260817.md)',
  },
  {
    key: 'short_momentum',
    name: '4H短周期动量',
    style: 'short_momentum',
    assetClass: 'equity',
    primaryTimeframe: '4H',
    confirmationTimeframe: '1D',
    hypothesis: 'OKX 4H 真实数据回测(2026-07~08, 40天)：30根4H动量(≈5日涨幅)≥1%时做多，持有8根(≈1.3天)，10x杠杆。257笔净+62.5% 胜率65%，三标的全正(KORU+16/SNDK+14/SNXX+32)，成本0.09%→0.2%不敏感。样本短(40天)，按规则接近度上线。',
    entryRule: '4H收盘：过去30根动量(涨幅)≥1% → 下一根开盘做多；杠杆≤10x',
    exitRule: '持有8根4H或止损(4H ATR×1.5)或动量转负提前退出；单标的手续费约束：月换手≤20次',
    status: 'enabled',
    evidence: 'OKX 4H回测257笔净+62.5% 胜率65% PF1.24(2026-07~08真实数据, 样本短待积累)',
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
        evidence: item.evidence || null,
        status: row ? row.status : item.status,
        enabled: row ? row.status === 'enabled' : item.status === 'enabled',
        updatedAt: row?.updatedAt || null,
      });
    }
    return strategies;
  }

  // 返回启用策略的 type/style 集合（信号引擎按此过滤：disabled 策略不参与仲裁）
  enabledTypes() {
    const types = [];
    for (const [key, item] of this.catalog) {
      if (item.status === 'enabled') types.push(item.style || key);
    }
    return types;
  }

  async setEnabled(principal, key, enabled) {
    if (!this.catalog.has(key)) throw new Error('策略不存在');
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

  tenant(principal) {
    return String(principal?.tenantId || '1');
  }
}
