// 常驻仓位管理器：内嵌到实盘系统，私有WS事件驱动 + 定时兜底
// 职责（用户授权"你来控制我已有仓位"，操作必须有理由）：
//   1. 保护单完整性：持仓必须有硬止损（缺则自动挂）
//   2. 保护单去重：同标的仅保留 1 硬止损 + 1 动态止损
//   3. 动态止损：方向强挂动态（激活价/回撤），方向弱仅硬止损
//   4. 仓位调整：风险超上限自动减仓（数学理由），加仓需明确确认
// 每次操作写审计日志 + 通过 onNotify 推送理由
export class PositionManager {
  constructor({ domain, getGateway, getAlgos, setProtection, amendAlgo, cancelAlgo, reducePosition, placeOrder, conviction, getAtrPct = async () => 0.003, getOpportunities = async () => [], getLotSz = async () => 0.01, getSignal = async () => null, getH4Momentum = async () => null, clock = () => new Date(), onNotify = () => {} } = {}) {
    this.domain = domain;
    this.getGateway = getGateway;
    this.getAlgos = getAlgos;
    this.setProtection = setProtection;
    this.amendAlgo = amendAlgo || (async () => { throw new Error('未配置修改算法单通道'); });
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
    this.consecutiveErrors = 0;
    this.errorHaltedUntil = 0;
    this.minIntervalMs = 15_000; // 同一持仓 15s 内不重复评估
    this.peakPrices = new Map();      // instId → {high, at} 持仓期间最高价（动态止损已弃用，保留结构）
    this.cooldowns = new Map();       // instId → 平仓时间戳（30分钟冷却）
    this.autoOpenEnabled = false;     // 自动开单默认关闭（安全开关）
    this.pendingSlInsts = new Set();  // 本进程已挂硬止损的标的（防重复挂单）
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
        const sm = (opp.signals || []).find((s) => s.type === 'momentum_select');
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
      // 止损平仓检测：最近30分钟该标的有"卖出平仓"成交(止损触发) → 冷却(防止止损后立刻接回)
      // bug修复: 止损平仓后positions条目被delete, 原冷却逻辑遍历不到 → 立刻重开
      const recentFills = this.domain.fills?.filter?.((f) => f.instId === opp.instId && f.sourceTs && (now - Date.parse(f.sourceTs)) < 30 * 60_000) || [];
      const stopOutFill = recentFills.find((f) => f.side === (opp.arbitration?.direction === 'long' ? 'sell' : 'buy'));
      if (stopOutFill) {
        this.cooldowns.set(opp.instId, Date.now());
        continue; // 刚止损平仓过，冷却30分钟
      }
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
      // 自动开单后立即挂止损（用户规则: SNDK 1%/其他 2%，覆盖全量，挂好不动）
      // 避免新仓裸奔；只有自动开单才挂，已有仓位的手动止损不干预
      try {
        const slDist = opp.instId === 'SNDK-USDT-SWAP' ? 0.01 : 0.02;
        const slPx = arb.direction === 'long' ? price * (1 - slDist) : price * (1 + slDist);
        const slResult = await this.setProtection(gateway, {
          instId: opp.instId, side: side === 'long' ? 'sell' : 'buy',
          slTriggerPx: Math.round(slPx * 100) / 100,
          size: qty,
        });
        this.pendingSlInsts.add(opp.instId); // 标记已挂，后续不再重复
        actions.push({
          action: '开仓挂止损', instId: opp.instId,
          detail: `新仓自动挂止损 ${Math.round(slPx * 100) / 100}（${(slDist * 100).toFixed(0)}% 距离，覆盖 ${qty} 张），挂好不动`,
        });
      } catch (slErr) {
        actions.push({ action: '开仓挂止损失败', instId: opp.instId, detail: `自动挂止损失败：${slErr?.message}，请手动设置止损` });
      }
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
    if (now < this.errorHaltedUntil) return { halted: true, retryAt: new Date(this.errorHaltedUntil).toISOString() };
    try {
      // 直接遍历内存中已连接的实盘账户（避免硬编码 principal）
      let account = null;
      for (const acc of this.domain.accounts.values()) {
        if (acc.environment === 'live') { account = acc; break; }
      }
      if (!account) return { noAccount: true };
      const gateway = this.getGateway(account.id);
      if (!gateway || gateway.status !== 'connected') return { gatewayOffline: true };
      this.consecutiveErrors = 0;
      this.errorHaltedUntil = 0;

      const positions = [...this.domain.positions.values()].filter((p) => p.accountId === account.id && Number(p.quantity) !== 0);
      // getAlgos 缓存 10s：实时盯仓(3s ticker)下避免每3秒打OKX REST 2次(限流20/2s)
      const algosCacheAge = this._algosCacheAt ? Date.now() - this._algosCacheAt : Infinity;
      let algos = this._algosCache || [];
      if (algosCacheAge > 10_000) {
        algos = await this.getAlgos(gateway).catch((e) => { process.stderr.write(`[仓位管理] getAlgos 失败: ${e?.stack || e}\n`); return []; });
        this._algosCache = algos;
        this._algosCacheAt = Date.now();
      }
      const actions = [];

      for (const pos of positions) {
        const instId = pos.instId;
        const qty = Math.abs(Number(pos.quantity));
        const side = pos.side;
        const entry = Number(pos.avgEntryPrice);
        const mark = Number(pos.markPrice);
        const liq = Number(pos.liquidationPrice);
        // 止损完全由用户手动设置（规则1/2/3 自动止损全禁用，2026-08-17）
        const positionAlgos = algos.filter((a) => a.instId === instId && a.state === 'live');
        const hardSl = positionAlgos.find((a) => (a.ordType === 'conditional' || a.ordType === 'oco') && Number(a.slTriggerPx));
        const conv = this.conviction(instId);
        const equity = Number(this.domain.riskSnapshots.get(account.id)?.equity || 0);
        // —— 持仓持续评估：信号是否仍生效（开仓后不能不管）——
        // 每次评估拉最新信号，失效则自动平仓（附理由）
        // 信号缓存 5s：getSignal 内部 buildWorkstation 较重，实时盯仓下避免每3s重复构建
        const sigCacheAge = this._sigCacheAt ? Date.now() - this._sigCacheAt : Infinity;
        let sig = this._sigCache || null;
        if (sigCacheAge > 5_000) {
          sig = await this.getSignal(instId).catch(() => null);
          this._sigCache = sig;
          this._sigCacheAt = Date.now();
        }
        if (sig) {
          const sigInvalid = sig.decision === 'neutral' || sig.decision === 'wait'
            || (side === 'long' && sig.direction === 'short')
            || (side === 'short' && sig.direction === 'long');
          if (sigInvalid) {
            // 用户要求: 信号失效只提醒, 不平仓(2026-08-17)
            // 原自动平仓已禁用, 推送提醒让用户决定
            actions.push({ action: '信号失效提醒', instId, detail: `持仓信号已失效（仲裁 ${sig.decision}/${sig.label}，方向 ${sig.direction}），建议平仓，需您确认` });
          }
        }
        const lossPerUnit = hardSl ? Math.abs(entry - Number(hardSl.slTriggerPx)) : mark * 0.02;
        const curRiskPct = equity ? (lossPerUnit * qty) / equity * 100 : 0;
        const targetRiskPct = 2 * (conv?.mult || 1);
        const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;

        // —— 规则1：硬止损 —— 已按用户要求关闭自动干预
        // 用户: "给我设置全仓止损，不要设置自动止损"（2026-08-17）
        // 系统不再自动挂/改止损，止损完全由用户手动设置，系统只读展示
        // （原自动挂止损逻辑已禁用）

        // —— 规则2：保护单去重 —— 已按用户要求关闭自动干预
        // 用户: "不要设置自动止损" — 系统不再自动取消/保留任何止损单
        // 去重曾误删用户手动止损(1719被系统按公式挂的1707覆盖)，风险太大，整体禁用
        // （原去重逻辑已禁用，止损由用户完全掌控）

        // —— 规则3：动态止损 —— 已按用户要求关闭（"不要设置自动止损"）
        // 只保留固定全仓止损（规则1/2），系统不再自动改止损
        // （原动态上移/回调逻辑已删除，2026-08-17）

        // —— 规则4：仓位风险自动减仓 —— 已禁用（用户: "你特么平我仓干你吗"）
        // bug: 实时盯仓下检测到仓位风险超限就自动减仓, 擅自动用户仓位
        // 用户要求: 系统绝不自动平仓/减仓, 只提醒
        // （原自动减仓逻辑已禁用，2026-08-17）

        // —— 规则5：动态止盈 —— 已禁用（用户: "取消系统实盘权限"）
        // 系统不再自动挂/改任何止盈单，止盈完全由用户手动设置
        // 原动态止盈(v2: 1%阈值+amend)已整体禁用，2026-08-17
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
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= 5) {
        this.errorHaltedUntil = Date.now() + 60_000;
        process.stderr.write('[仓位管理] 连续失败5次，熔断60秒: ' + error.message + '\n');
      }
      return { error: error.message };
    }
  }
}
