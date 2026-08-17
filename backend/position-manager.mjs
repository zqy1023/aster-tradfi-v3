// 常驻仓位管理器：内嵌到实盘系统，私有WS事件驱动 + 定时兜底
// 职责（用户授权"你来控制我已有仓位"，操作必须有理由）：
//   1. 保护单完整性：持仓必须有硬止损（缺则自动挂）
//   2. 保护单去重：同标的仅保留 1 硬止损 + 1 动态止损
//   3. 动态止损：方向强挂动态（激活价/回撤），方向弱仅硬止损
//   4. 仓位调整：风险超上限自动减仓（数学理由），加仓需明确确认
// 每次操作写审计日志 + 通过 onNotify 推送理由
export class PositionManager {
  constructor({ domain, getGateway, getAlgos, setProtection, setTrailing, cancelAlgo, reducePosition, conviction, clock = () => new Date(), onNotify = () => {} } = {}) {
    this.domain = domain;
    this.getGateway = getGateway;
    this.getAlgos = getAlgos;
    this.setProtection = setProtection;
    this.setTrailing = setTrailing;
    this.cancelAlgo = cancelAlgo;
    this.reducePosition = reducePosition || (async () => { throw new Error('未配置减仓执行通道'); });
    this.conviction = conviction;
    this.clock = clock;
    this.onNotify = onNotify;
    this.lastRun = 0;
    this.minIntervalMs = 15_000; // 同一持仓 15s 内不重复评估
  }

  // 主入口：由私有WS事件触发（节流）或定时器兜底
  async evaluate({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastRun < this.minIntervalMs) return { skipped: true };
    this.lastRun = now;
    try {
      // 直接遍历内存中已连接的实盘账户（避免硬编码 principal）
      let account = null;
      for (const acc of this.domain.accounts.values()) {
        if (acc.environment === 'live') { account = acc; break; }
      }
      if (!account) return { noAccount: true };
      const gateway = this.getGateway(account.id);
      if (!gateway || gateway.status !== 'connected') return { gatewayOffline: true };

      const positions = [...this.domain.positions.values()].filter((p) => p.accountId === account.id && Number(p.quantity) !== 0);
      const algos = await this.getAlgos(gateway).catch((e) => { process.stderr.write(`[仓位管理] getAlgos 失败: ${e?.stack || e}\n`); return []; });
      const actions = [];

      for (const pos of positions) {
        const instId = pos.instId;
        const qty = Math.abs(Number(pos.quantity));
        const side = pos.side;
        const entry = Number(pos.avgEntryPrice);
        const mark = Number(pos.markPrice);
        const liq = Number(pos.liquidationPrice);
        const positionAlgos = algos.filter((a) => a.instId === instId && a.state === 'live');
        const hardSl = positionAlgos.find((a) => (a.ordType === 'conditional' || a.ordType === 'oco') && Number(a.slTriggerPx));
        const trailing = positionAlgos.find((a) => a.ordType === 'move_order_stop' || Number(a.callbackRatio) > 0);
        const conv = this.conviction(instId);
        const equity = Number(this.domain.riskSnapshots.get(account.id)?.equity || 0);
        const lossPerUnit = hardSl ? Math.abs(entry - Number(hardSl.slTriggerPx)) : mark * 0.02;
        const curRiskPct = equity ? (lossPerUnit * qty) / equity * 100 : 0;
        const targetRiskPct = 2 * (conv?.mult || 1);
        const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;

        // —— 规则1：硬止损 —— 只读不干预：用户手动挂的(最新conditional)优先
        // 系统只在"完全没有硬止损"时才补一个 2% 距离的（保护裸仓）
        if (!hardSl && !positionAlgos.some((a) => Number(a.slTriggerPx))) {
          const slPx = side === 'long' ? mark * 0.98 : mark * 1.02; // 默认 2% 距离
          await this.setProtection(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', slTriggerPx: slPx });
          actions.push({ action: '挂硬止损', instId, detail: `持仓无硬止损，自动挂 ${slPx.toFixed(2)}（2% 距离），如已在 App 挂过请忽略` });
        }

        // —— 规则2：保护单去重 —— 保留最新创建的（用户手动改的优先）
        const hardSlAlgos = positionAlgos.filter((a) => (a.ordType === 'conditional' || a.ordType === 'oco') && Number(a.slTriggerPx));
        if (hardSlAlgos.length > 1) {
          // 按 cTime 排序，保留最新的
          hardSlAlgos.sort((a, b) => Number(a.cTime || 0) - Number(b.cTime || 0));
          const keep = hardSlAlgos[hardSlAlgos.length - 1];
          for (const dup of hardSlAlgos.slice(0, -1)) {
            await this.cancelAlgo(gateway, { instId, algoId: dup.algoId });
            actions.push({ action: '取消重复硬止损', instId, detail: `存在多个硬止损，取消 ${dup.algoId}（保留最新 ${keep.algoId} = ${keep.slTriggerPx}）` });
          }
        }

        // —— 规则3：动态止损 ——
        // 方向强烈(≥2.5x)且无动态 → 挂；有动态但方向转弱 → 取消（避免误锁）
        if (conv?.mult >= 2.5 && !trailing && distLiq !== null && distLiq > 2) {
          const activePx = side === 'long' ? mark * 1.005 : mark * 0.995; // 现价上方0.5%激活
          await this.setTrailing(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', size: qty, callbackRatio: 0.01, activePx });
          actions.push({ action: '挂动态止损', instId, detail: `方向强烈 ×${conv.mult}，激活 ${activePx.toFixed(2)} / 回撤1%` });
        } else if (trailing && conv?.mult < 2 && conv?.level === '偏弱') {
          await this.cancelAlgo(gateway, { instId, algoId: trailing.algoId });
          actions.push({ action: '取消动态止损', instId, detail: `方向转弱（${conv.level}），移除动态止损仅保留硬止损` });
        }

        // —— 规则4：仓位风险（自动减仓到目标风险，附数学理由）——
        // 触发：止损风险 > 方向上限 × 1.5 且距清算 < 8%（杠杆仓位必须有缓冲）
        if (curRiskPct > targetRiskPct * 1.5 && distLiq !== null && distLiq < 8) {
          const targetQty = equity * targetRiskPct / 100 / lossPerUnit;   // 目标张数(风险=上限)
          const reduceQty = Math.max(0, qty - targetQty);
          if (reduceQty > 0.05) {
            await this.reducePosition(gateway, { instId, side, qty: reduceQty });
            actions.push({
              action: '自动减仓',
              instId,
              detail: `止损风险 ${curRiskPct.toFixed(1)}% 超方向上限 ${targetRiskPct.toFixed(1)}% 的 1.5 倍 → 减 ${reduceQty.toFixed(2)} 张（留 ${targetQty.toFixed(2)} 张），数学：目标张数 = 权益×${targetRiskPct.toFixed(1)}% ÷ 每张止损亏损 ${lossPerUnit.toFixed(2)}`,
            });
          }
        }
      }

      if (actions.length) {
        this.onNotify(actions);
      }
      return { positions: positions.length, actions };
    } catch (error) {
      return { error: error.message };
    }
  }
}
