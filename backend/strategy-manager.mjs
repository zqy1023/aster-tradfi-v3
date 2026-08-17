// 策略管理：内置策略目录 + 启用/停用
// 基于因子研究(FACTOR_RESEARCH_20260817.md)的结论：
//   方向因子(技术指标)无稳定alpha → 删除旧3策略(突破回踩/动量延续/区间高抛低吸)
//   横截面12月动量 Sharpe 1.42 有效 → 动量选股
//   波动率预测 IC 0.3-0.4 稳定 → 波动率目标仓位(风控层)

const DEFAULT_STRATEGIES = [
  {
    key: 'momentum_select',
    name: 'Top5月度动量组合（已停用）',
    style: 'momentum_select',
    assetClass: 'equity',
    primaryTimeframe: '1M',
    confirmationTimeframe: '1D',
    hypothesis: '每月末按过去12个月收益排序，持有Top5，并用20日已实现波动过滤高波标的。可复算回测为年化1.4%、Sharpe0.27、最大回撤13.6%；它不是高收益策略，定位是低频、低风险、可审计的组合基准。',
    entryRule: '停用。12月动量周期太长，被滚仓v5替代。',
    exitRule: '停用。',
    status: 'disabled',
    evidence: '2026-08-17 用户要求短周期/高收益，12月动量弃用，改用滚仓v5(20日动量)。',
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
    name: '4H短周期动量（已停用）',
    style: 'short_momentum',
    assetClass: 'equity',
    primaryTimeframe: '4H',
    confirmationTimeframe: '1D',
    hypothesis: '已被重新设计替换：样本仅40天且使用10x杠杆，风险不可接受。',
    entryRule: '停用。',
    exitRule: '停用。',
    status: 'disabled',
    evidence: '2026-08-17策略审计认定样本不足、收益不可复算，禁止自动实盘。',
  },
  {
    key: 'intraday_momentum',
    name: '15m日内动量（已停用）',
    style: 'intraday_momentum',
    assetClass: 'equity',
    primaryTimeframe: '15m',
    confirmationTimeframe: '4H',
    hypothesis: '15m动量(24根≈6小时)日内趋势，持仓1-6小时，日内平仓',
    entryRule: '停用。数据不足(OKX 15m仅3天)且Yahoo现货日收益相关仅0.34。',
    exitRule: '停用。',
    status: 'disabled',
    evidence: '2026-08-17日内训练过拟合(训练1935→验证160)，禁止实盘。',
  },
  {
    key: 'roll_momentum',
    name: '滚仓动量v5（多空双向）',
    style: 'roll_momentum',
    assetClass: 'equity',
    primaryTimeframe: '1D',
    confirmationTimeframe: '1D',
    hypothesis: '趋势过滤(SPY200日线+20日动量同向) + 动量#1#2多/垫底2空 + 3x杠杆 + 移动止损 + 滚仓。10年5标的跨期验证5年全正(含真实成本): 2022+1014% 2023+60% 2024+1772% 2025+156% 2026+384%',
    entryRule: 'SPY>200日线且20日动量>0 → 做多动量排名#1#2(各50%)；SPY<200日线且20日动量<0 → 做空动量垫底2(各50%)；震荡空仓',
    exitRule: '止损-15%或移动止损(+30%保本/+60%锁利)；止盈+80%；持仓10天强制平；平仓立即滚下一批',
    status: 'enabled',
    evidence: 'scripts/roll-v5-realcost.py 10年11标的含手续费0.1%+滑点0.2%+资金费0.03%/天',
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
    const status = enabled ? 'enabled' : 'disabled';
    const row = this.repository
      ? await this.repository.upsertStrategy({
          key,
          tenantId: this.tenant(principal),
          name: this.catalog.get(key).name,
          style: this.catalog.get(key).style,
          assetClass: this.catalog.get(key).assetClass,
          primaryTimeframe: this.catalog.get(key).primaryTimeframe,
          confirmationTimeframe: this.catalog.get(key).confirmationTimeframe,
          hypothesis: this.catalog.get(key).hypothesis,
          status,
          updatedAt: this.clock().toISOString(),
        })
      : null;
    this.catalog.get(key).status = status;
    return { key, enabled, row };
  }

  tenant(principal) {
    return String(principal?.tenantId || '1');
  }
}
