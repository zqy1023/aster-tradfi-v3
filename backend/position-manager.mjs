// 常驻仓位管理器：内嵌到实盘系统，私有WS事件驱动 + 定时兜底
// 职责（用户授权"你来控制我已有仓位"，操作必须有理由）：
//   1. 保护单完整性：持仓必须有硬止损（缺则自动挂）
//   2. 保护单去重：同标的仅保留 1 硬止损 + 1 动态止损
//   3. 动态止损：方向强挂动态（激活价/回撤），方向弱仅硬止损
//   4. 仓位调整：风险超上限自动减仓（数学理由），加仓需明确确认
// 每次操作写审计日志 + 通过 onNotify 推送理由
export class PositionManager {
  constructor({ domain, getGateway, getAlgos, setProtection, setTrailing, cancelAlgo, reducePosition, placeOrder, conviction, getAtrPct = async () => 0.003, getOpportunities = async () => [], getLotSz = async () => 0.01, getSignal = async () => null, getH4Momentum = async () => null, clock = () => new Date(), onNotify = () => {} } = {}) {
    this.domain = domain;
    this.getGateway = getGateway;
    this.getAlgos = getAlgos;
    this.setProtection = setProtection;
    this.setTrailing = setTrailing;
    this.cancelAlgo = cancelAlgo;
    this.reducePosition = reducePosition || (async () => { throw new Error('未配置减仓执行通道'); });
    this.placeOrder = placeOrder || (async () => { throw new Error('未配置开仓执行通道'); });
    this.conviction = conviction;
    this.getAtrPct = getAtrPct;
    this.getOpportunities = getOpportunities;
    this.getLotSz = getLotSz;
    this.getSignal = getSignal;
    this.getH4Momentum = getH4Momentum;
    this.clock = clock;
    this.onNotify = onNotify;
    this.lastRun = 0;
    this.minIntervalMs = 15_000; // 同一持仓 15s 内不重复评估
    this.peakPrices = new Map();      // instId → {high, at} 持仓期间最高价
    this.sysTrailingIds = new Set();  // 系统自管动态止损的 algoId 集合
    this.cooldowns = new Map();       // instId → 平仓时间戳（30分钟冷却）
    this.autoOpenEnabled = false;     // 自动开单默认关闭（安全开关）
    this.lastTrailingMove = new Map(); // instId → 上次动态止损移动时间（10分钟冷却）
    this.pendingSlInsts = new Set();   // 本进程已挂硬止损的标的（防重复挂单）
  }

  // 自动开单：默认禁用！只有显式开启(AUTO_TRADE_ENABLED)才允许
  // 教训(2026-08-17): 未充分验证的仓位公式导致SNXX开39.6张大仓, 必须先人工确认
  async autoOpen({ gateway, account, opportunities, actions } = {}) {
    if (!this.autoOpenEnabled) return { disabled: true };
    const equity = Number(this.domain.riskSnapshots.get(account.id)?.equity || 0);
    const available = Number(account.available || this.domain.riskSnapshots.get(account.id)?.available || equity);
    const held = new Set([...this.domain.positions.values()].filter((p) => p.accountId === account.id && Number(p.quantity) !== 0).map((p) => p.instId));
    const openedThisRound = new Set(); // 本轮已开的标的（防止内存同步延迟导致重复开仓）
    const now = Date.now();
    // —— 信号强度排序：动量排名绝对主导（用户要求取最强）——
    // 排序分 = 动量排名分位(80%) + 4H动量得分(15%) + 成交量(5%)
    // 修复2: 原权重60/25/15下, SNXX流动性93分(15%)反超SNDK动量99分(60%)差距
    //        SNDK 99*0.6=59.4 vs SNXX 82*0.6=49.2 差10.2; 流动性 SNXX 14 vs SNDK 2 差12 → 反超
    //        动量必须主导: 80%权重, 流动性仅5%(保底不主导)
    const scored = (opportunities || [])
      .map((opp) => {
        const mom = opp.momentum;
        const sm = (opp.signals || []).find((s) => s.type === 'short_momentum');
        // 动量排名分位: rank 1/68 → 98.5分; rank 12/68 → 82.4分
        const momScore = mom?.rank && mom?.total ? (1 - mom.rank / mom.total) * 100 : 0;
        const h4Score = sm ? sm.score : 0;                                     // 4H动量分
        const liqScore = Math.min(100, Number(opp.volume24h || 0) / 4_000_000 * 100); // 流动性
        const total = momScore * 0.8 + h4Score * 0.15 + liqScore * 0.05;
        return { opp, total, momScore, h4Score };
      })
      .sort((a, b) => b.total - a.total);
    for (const { opp, total, momScore, h4Score } of scored) {
      if (held.has(opp.instId)) continue;                 // 已有持仓不开
      const cooldown = this.cooldowns.get(opp.instId);
      if (cooldown && now - cooldown < 30 * 60_000) continue; // 平仓后30分钟冷却
      const arb = opp.arbitration || {};
      if (!arb.decision || !arb.decision.startsWith('final')) continue; // 非 final 不开
      const conv = this.conviction(opp.instId);
      if (conv.mult < 2) continue;                        // 方向不够强
      // 波动率过滤：vol_target 信号 evidence 含"波动飙升"则不开
      const volSig = (opp.signals || []).find((s) => s.type === 'vol_target');
      if ((volSig?.evidence || []).join(' ').includes('波动飙升')) continue;
      // ===== 仓位公式 v7（用户规则定稿 2026-08-17）=====
      // 约束：
      //   A. 风险预算: 止损亏损 ≤ 2%×方向系数 权益（最多6%）
      //   B. 名义上限: 单笔名义 ≤ 权益 × 100%（用户指定：单笔≤100%权益，不是250%上限）
      //   C. 保证金:   按 10x 杠杆算, 保证金 ≤ 可用 × 30%
      //   D. 单笔开仓: 每轮最多开一笔（用户规则）
      //   E. 硬止损:   止损距离 ≤ 现价 × 2%（用户规则）
      const price = Number(opp.price);
      if (!price || price <= 0) continue;
      const atrPct = await this.getAtrPct(opp.instId).catch(() => 0.02);
      // E. 硬止损距离：≤ 现价×2%（用户规则）；SNDK 例外用 1%（用户指定：SNDK止损1%能开1张）
      // 其他标的 1%~2%，SNDK 固定 1%
      const slPct = opp.instId === 'SNDK-USDT-SWAP'
        ? 0.01
        : Math.min(0.02, Math.max(0.01, atrPct * 2)); // 止损距离 1%~2%（上限2%）
      const riskBudgetPct = Math.min(0.06, 0.02 * conv.mult);    // 风险预算上限6%
      const riskUsd = equity * riskBudgetPct;
      const lossPerUnit = price * slPct;
      const lotSz = await this.getLotSz(opp.instId).catch(() => 0.01) || 0.01;
      // A. 风险预算约束的张数
      let qtyA = Math.floor(riskUsd / lossPerUnit / lotSz + 1e-9) * lotSz;
      // B. 单笔名义上限约束：名义 ≤ 权益 × 100%（用户规则）
      //    SNDK 例外：1张最小名义1735U=372%权益, 用户指定"破例放开"（最强动量+3416%）
      const notionalCap = opp.instId === 'SNDK-USDT-SWAP' ? equity * 5.0 : equity * 1.0;
      let qtyB = Math.floor(notionalCap / price / lotSz + 1e-9) * lotSz;
      // C. 保证金约束（按标的杠杆: SNDK 20x, 其他 10x; 保证金 ≤ 可用×30%）
      const lever = opp.instId === 'SNDK-USDT-SWAP' ? 20 : 10;
      const marginCap = available * 0.3;
      let qtyC = Math.floor(marginCap * lever / price / lotSz + 1e-9) * lotSz;
      // 取三者最小
      let qty = Math.min(qtyA, qtyB, qtyC);
      if (qty <= 0) qty = lotSz;
      // 浮点修正：转字符串去尾（消除 25.700000000000003，OKX 51121 拒单）
      // round 不够（0.1 进制浮点误差），用 toFixed(6) 后 Number 再按 lotSz 取整
      qty = Number((Math.floor(qty / lotSz) * lotSz).toFixed(6));
      // 组合预算：已有持仓名义 + 本次 ≤ 权益×100%（SNDK例外5倍）
      const comboCap = opp.instId === 'SNDK-USDT-SWAP' ? equity * 5.0 : equity * 1.0;
      let usedNotional = 0;
      for (const p of this.domain.positions.values()) {
        if (p.accountId === account.id && Number(p.quantity) !== 0) {
          usedNotional += Math.abs(Number(p.quantity)) * Number(p.markPrice || 0);
        }
      }
      if (usedNotional + qty * price > comboCap) {
        const remain = Math.max(0, comboCap - usedNotional);
        qty = Number((Math.floor(remain / price / lotSz + 1e-9) * lotSz).toFixed(6)); // 浮点修正
      }
      if (qty < lotSz) continue; // 预算不足，跳过该标的
      // D. 单笔开仓：已有持仓 或 本轮已开过 → 不再开（用户规则：每次只能开一笔）
      // 用 openedThisRound 防止内存同步延迟导致的重复开仓（实测bug: SNXX+KORU同轮都开了）
      if (held.size > 0 || openedThisRound.size > 0) continue;
      // 记录约束明细供理由展示
      const constraintNote = `风险预算${qtyA.toFixed(2)}张 / 名义100%${qtyB.toFixed(2)}张 / 保证金${qtyC.toFixed(2)}张(${lever}x) → 取 ${qty.toFixed(2)}张(名义${(qty*price).toFixed(0)}U=${((qty*price)/equity*100).toFixed(0)}%权益, 止损${(slPct*100).toFixed(1)}%距离)`;
      // 执行开仓（市价）— clOrdId 需仅字母数字
      const side = arb.direction === 'short' ? 'sell' : 'buy';
      const intent = {
        id: `AUTO${Date.now()}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
        instId: opp.instId, side, orderType: 'market', size: qty, reduceOnly: false,
      };
      const result = await this.placeOrder(gateway, intent);
      openedThisRound.add(opp.instId); // 标记本轮已开，后续标的跳过
      actions.push({
        action: '自动开仓', instId: opp.instId,
        detail: `信号 ${arb.label}（${conv.level} ×${conv.mult}）→ 开 ${qty} 张 @${price.toFixed(2)}，强度分${total.toFixed(0)}（12月动量${momScore.toFixed(0)} + 4H${h4Score.toFixed(0)}），${constraintNote}`,
      });
      this.cooldowns.delete(opp.instId);
    }
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
        // —— 持仓持续评估：信号是否仍生效（开仓后不能不管）——
        // 每次评估拉最新信号，失效则自动平仓（附理由）
        const sig = await this.getSignal(instId).catch(() => null);
        if (sig) {
          const sigInvalid = sig.decision === 'neutral' || sig.decision === 'wait'
            || (side === 'long' && sig.direction === 'short')
            || (side === 'short' && sig.direction === 'long');
          if (sigInvalid) {
            await this.reducePosition(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', qty });
            this.cooldowns.set(instId, Date.now()); // 冷却30分钟
            actions.push({ action: '信号失效平仓', instId, detail: `持仓信号已失效（仲裁 ${sig.decision}/${sig.label}，方向 ${sig.direction}），自动平 ${qty} 张` });
            continue; // 已平仓，跳过后续规则
          }
        }
        // —— 4H 动量转负检测（short_momentum 退出规则）——
        // 持仓期间 30 根 4H 动量转负 → 趋势破坏，自动平仓
        const h4Mom = await this.getH4Momentum(instId).catch(() => null);
        if (h4Mom !== null && h4Mom < 0) {
          await this.reducePosition(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', qty });
          this.cooldowns.set(instId, Date.now());
          actions.push({ action: '动量转负平仓', instId, detail: `30根4H动量转负（${(h4Mom * 100).toFixed(2)}%），趋势破坏，自动平 ${qty} 张` });
          continue;
        }
        const lossPerUnit = hardSl ? Math.abs(entry - Number(hardSl.slTriggerPx)) : mark * 0.02;
        const curRiskPct = equity ? (lossPerUnit * qty) / equity * 100 : 0;
        const targetRiskPct = 2 * (conv?.mult || 1);
        const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;

        // —— 规则1：硬止损 —— 只读不干预：用户手动挂的(最新conditional)优先
        // 系统只在"完全没有硬止损"时才补一个（用户规则：硬止损 < 实际仓位2%；SNDK用1%）
        // 修复bug: setProtection 必须传 sz=持仓数量, 否则OKX默认sz:1只覆盖1张(实测1717.79 sz:1裸仓)
        if (!hardSl && !positionAlgos.some((a) => Number(a.slTriggerPx)) && !this.pendingSlInsts.has(instId)) {
          const slDistPct = instId === 'SNDK-USDT-SWAP' ? 0.99 : 0.98; // SNDK 1%距离, 其他2%
          const slPx = side === 'long' ? mark * slDistPct : mark * (2 - slDistPct);
          const result = await this.setProtection(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', slTriggerPx: Math.round(slPx * 100) / 100, size: qty });
          if (result?.[0]?.algoId) this.pendingSlInsts.add(instId); // 记录已挂，本轮不再重复
          actions.push({ action: '挂硬止损', instId, detail: `持仓无硬止损，自动挂 ${slPx.toFixed(2)}（覆盖${qty}张, ${instId === 'SNDK-USDT-SWAP' ? '1%' : '2%'} 距离），如已在 App 挂过请忽略` });
        }

        // —— 规则2：保护单去重 —— 保留"覆盖全量"的单（sz 最大或 closeFraction=1）
        // 修复bug: 原来按cTime保留最新, 但sz:1的部分单cTime更新反而被保留,
        //         导致覆盖全量的单被取消, 持仓变裸仓(实测: 1717.79 sz:1保留, 1706.89全量被删)
        const hardSlAlgos = positionAlgos.filter((a) => (a.ordType === 'conditional' || a.ordType === 'oco') && Number(a.slTriggerPx));
        if (hardSlAlgos.length > 1) {
          // 覆盖数量: sz 数字大者覆盖全; 空sz或closeFraction=1视为全量
          const coverage = (a) => {
            const sz = Number(a.sz || 0);
            if (sz > 0) return sz;
            return a.closeFraction === '1' || a.closeFraction === 1 ? 999 : 1;
          };
          hardSlAlgos.sort((a, b) => coverage(b) - coverage(a));
          const keep = hardSlAlgos[0];
          for (const dup of hardSlAlgos.slice(1)) {
            await this.cancelAlgo(gateway, { instId, algoId: dup.algoId });
            actions.push({ action: '取消重复硬止损', instId, detail: `存在多个硬止损，取消 ${dup.algoId}（保留覆盖全量 ${keep.algoId} = ${keep.slTriggerPx} sz=${keep.sz || '全量'}）` });
          }
        }

        // —— 规则3：系统自管动态止损（实时调整，替代 OKX 黑盒 move_order_stop）——
        // 系统跟踪持仓期间的最高价，按 ATR 自适应回调比例算触发线，用条件单实时更新
        // 触发线只上移不下移；波动大放宽(避免被扫)、波动小收紧(锁利)
        const peak = this.peakPrices.get(instId) || { high: mark, at: Date.now() };
        if (mark > peak.high) { peak.high = mark; peak.at = Date.now(); this.peakPrices.set(instId, peak); }
        // 自适应回调：1分钟级波动约 0.1-0.3%，回调取波动 × 1.2，夹在 0.3%~1.5%
        // 用户规则: 硬止损<2%距离 → 回调上限1.5%保证止损在2%内
        const atrPct = await this.getAtrPct(instId).catch(() => 0.003);
        const callback = Math.min(0.015, Math.max(0.003, atrPct * 1.2));
        const triggerLine = side === 'long' ? peak.high * (1 - callback) : peak.high * (1 + callback);
        // 已有动态条件单（系统自管）→ 触发线只上移：至少上移 0.5% 才更新（避免微小波动高频重挂）
        const sysTrailing = positionAlgos.find((a) => a.ordType === 'conditional' && a.algoId && (a.tag === 'sys-trailing' || this.sysTrailingIds.has(a.algoId)));
        const nativeTrailing = positionAlgos.find((a) => a.ordType === 'move_order_stop');
        const currentTrigger = sysTrailing ? Number(sysTrailing.slTriggerPx || 0) : 0;
        // 阈值 0.5%（原 0.05% 太敏感：18元标的0.05%=0.009元，任何波动都触发）
        // 且每标的 10 分钟冷却，避免 15s ticker 高频取消+重挂（churn 产生空窗和限流）
        const lastMove = this.lastTrailingMove.get(instId) || 0;
        const cooldownOk = Date.now() - lastMove > 10 * 60_000;
        const shouldUpdate = side === 'long'
          ? triggerLine > currentTrigger * 1.005 && cooldownOk
          : triggerLine < currentTrigger * 0.995 && cooldownOk;
        if (conv?.mult >= 2 && distLiq !== null && distLiq > 2) {
          // 取消 OKX 原生黑盒 move_order_stop（系统接管后不依赖它）
          if (nativeTrailing && !sysTrailing) {
            await this.cancelAlgo(gateway, { instId, algoId: nativeTrailing.algoId });
            actions.push({ action: '接管动态止损', instId, detail: `取消 OKX 原生 move_order_stop（黑盒），改为系统自管条件单` });
          }
          if (!sysTrailing) {
            const result = await this.setProtection(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', slTriggerPx: Math.round(triggerLine * 100) / 100, size: qty });
            const algoId = result?.[0]?.algoId;
            if (algoId) this.sysTrailingIds.add(algoId);
            this.lastTrailingMove.set(instId, Date.now());
            actions.push({ action: '挂动态止损', instId, detail: `系统自管：高点 ${peak.high.toFixed(2)} × (1-回调${(callback * 100).toFixed(2)}%) = 触发 ${triggerLine.toFixed(2)}` });
          } else if (shouldUpdate) {
            // 上移：取消旧的 + 挂新的（触发线只上移，锁住更多利润）
            await this.cancelAlgo(gateway, { instId, algoId: sysTrailing.algoId });
            const result = await this.setProtection(gateway, { instId, side: side === 'long' ? 'sell' : 'buy', slTriggerPx: Math.round(triggerLine * 100) / 100, size: qty });
            const newId = result?.[0]?.algoId;
            if (newId) { this.sysTrailingIds.delete(sysTrailing.algoId); this.sysTrailingIds.add(newId); }
            this.lastTrailingMove.set(instId, Date.now());
            actions.push({ action: '上移动态止损', instId, detail: `高点 ${peak.high.toFixed(2)} 回调${(callback * 100).toFixed(2)}% → 触发线上移 ${currentTrigger.toFixed(2)} → ${triggerLine.toFixed(2)}（锁利）` });
          }
        } else if (sysTrailing && (conv?.mult < 2 || distLiq === null || distLiq <= 2)) {
          await this.cancelAlgo(gateway, { instId, algoId: sysTrailing.algoId });
          this.sysTrailingIds.delete(sysTrailing.algoId);
          actions.push({ action: '取消动态止损', instId, detail: `方向转弱或清算过近，移除系统动态止损仅保留硬止损` });
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

      // 记录刚平仓的标的（冷却30分钟避免立即重开）
      for (const [key, p] of this.domain.positions.entries()) {
        if (p.accountId === account.id && Number(p.quantity) === 0 && p.instId) {
          const instId = p.instId;
          if (!this.cooldowns.has(instId)) this.cooldowns.set(instId, Date.now());
        }
      }
      // 清理过期冷却
      for (const [instId, ts] of this.cooldowns) { if (Date.now() - ts > 30 * 60_000) this.cooldowns.delete(instId); }

      // —— 规则5：自动开单（策略信号 final + 资金充足）——
      const opportunities = await this.getOpportunities(account).catch((e) => { process.stderr.write(`[仓位管理] getOpportunities失败: ${e?.message}\n`); return []; });
      process.stderr.write(`[仓位管理] autoOpen信号源: ${opportunities.length}个final机会 ${opportunities.map((o) => o.instId).join(',') || '无'}\n`);
      try {
        await this.autoOpen({ gateway, account, opportunities, actions });
      } catch (e) {
        process.stderr.write(`[仓位管理] autoOpen失败: ${e?.message}\n`);
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
