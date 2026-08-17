const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const pct = (value) => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
const last = (items) => Array.isArray(items) && items.length ? items[items.length - 1] : null;

const BEIJING_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const NEW_YORK_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function ma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = value * k + result * (1 - k);
  return result;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function adxLite(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let positive = 0;
  let negative = 0;
  let range = 0;
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    positive += Math.max(0, current.high - previous.high);
    negative += Math.max(0, previous.low - current.low);
    range += Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
  }
  if (!range) return 0;
  return Math.abs(positive - negative) / range * 100;
}

function vwap(candles) {
  const totals = candles.reduce((acc, candle) => {
    const volume = finite(candle.volume, 0);
    const typical = (finite(candle.high, 0) + finite(candle.low, 0) + finite(candle.close, 0)) / 3;
    acc.priceVolume += typical * volume;
    acc.volume += volume;
    return acc;
  }, { priceVolume: 0, volume: 0 });
  return totals.volume ? totals.priceVolume / totals.volume : null;
}

function distancePct(price, level) {
  if (!price || !level) return null;
  return (level / price - 1) * 100;
}

function marketSession(ts = Date.now()) {
  const parts = Object.fromEntries(NEW_YORK_PARTS.formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
  const weekday = parts.weekday;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) return { label: '美股休市', state: 'closed', risk: '跳空风险高，禁止把盘中策略当作连续行情' };
  if (minutes < 4 * 60) return { label: '美股休市', state: 'closed', risk: '等待盘前流动性恢复' };
  if (minutes < 9 * 60 + 30) return { label: '盘前', state: 'pre', risk: '盘口较薄，预检需要放大点差/滑点' };
  if (minutes < 16 * 60) return { label: '盘中', state: 'regular', risk: '允许执行已完成计划的交易' };
  if (minutes < 20 * 60) return { label: '盘后', state: 'post', risk: '成交活跃度下降，谨慎加仓' };
  return { label: '美股休市', state: 'closed', risk: '隔夜跳空和资金费需要单独评估' };
}

function summarizeCandles(candles) {
  const clean = (candles || []).filter((item) => item.confirm !== false && Number.isFinite(Number(item.close)));
  const closes = clean.map((item) => Number(item.close));
  const current = last(clean);
  const atr14 = atr(clean, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const adx14 = adxLite(clean, 14);
  const vwap20 = vwap(clean.slice(-20));
  const previous20 = clean.slice(-21, -1);
  const high20 = previous20.length ? Math.max(...previous20.map((item) => item.high)) : null;
  const low20 = previous20.length ? Math.min(...previous20.map((item) => item.low)) : null;
  const atrPct = current && atr14 ? atr14 / current.close * 100 : null;
  // ATR% 的 20 日均值（用于波动率目标仓位的相对判断）
  let atr20Pct = null;
  if (clean.length >= 34) {
    const atrArr = [];
    for (let idx = clean.length - 20; idx < clean.length; idx++) {
      const sub = clean.slice(0, idx + 1);
      const a = atr(sub, 14);
      if (a && sub.at(-1)?.close) atrArr.push(a / sub.at(-1).close * 100);
    }
    if (atrArr.length >= 10) atr20Pct = atrArr.reduce((a, b) => a + b, 0) / atrArr.length;
  }
  return { count: clean.length, current, closes, atr14, atrPct, atr20Pct, ema20, ema50, rsi14, adx14, vwap20, high20, low20 };
}

function signalLine({ name, direction, ready, score, scoreBasis = [], evidence, blockers, triggerDistancePct, type }) {
  return {
    name,
    type,
    direction,
    status: ready ? 'ready' : blockers.length ? 'blocked' : 'watch',
    score: clamp(Math.round(score), 0, 100),
    scoreBasis,
    triggerDistancePct: pct(triggerDistancePct),
    evidence,
    blockers,
  };
}

function buildSignals(instrument, snapshot, candleSet, context = {}) {
  const daily = summarizeCandles(candleSet['1D']?.length ? candleSet['1D'] : candleSet['4H'] || candleSet.default || []);
  const fourHour = summarizeCandles(candleSet['4H']?.length ? candleSet['4H'] : candleSet.default || []);
  // —— 4H 短周期动量：30根动量≥1% → 做多信号 ——
  const h4Closes = fourHour.closes || [];
  const momWin = 30;
  let shortMom = null; // {momPct, ready}
  if (h4Closes.length >= momWin + 1) {
    const start = h4Closes[h4Closes.length - 1 - momWin];
    const end = h4Closes[h4Closes.length - 1];
    if (start > 0) {
      const momPct = (end - start) / start;
      shortMom = { momPct, ready: momPct >= 0.01 };
    }
  }
  const price = finite(snapshot?.last, finite(daily.current?.close, null));
  if (!price || daily.count < 20) {
    return [
      signalLine({
        name: '12月动量选股',
        type: 'momentum_select',
        direction: 'neutral',
        ready: false,
        score: 12,
        scoreBasis: ['数据可用性基础分 12；K线不足，不叠加任何策略分'],
        triggerDistancePct: null,
        evidence: ['历史 K 线不足，不能生成可执行策略证据'],
        blockers: ['等待 OKX 历史 K 线补齐到至少 20 根'],
      }),
    ].filter((signal) => {
      // 与主信号数组一致：只保留启用策略
      const enabled = context.enabledStrategies;
      if (!enabled || !enabled.length) return true;
      return enabled.includes(signal.type);
    });
  }
  const atrValue = daily.atr14 || Math.max(price * 0.025, Number(instrument.tickSize || 0.01) * 20);
  const liquidityOk = finite(snapshot?.volume24h, 0) > 0;
  const spreadBps = snapshot?.bid && snapshot?.ask ? (snapshot.ask - snapshot.bid) / price * 10_000 : null;
  const spreadOk = spreadBps === null || spreadBps <= 35;
  // —— 策略 1：12月横截面动量（月度调仓 Top3-5，最强 alpha：5年代理年化73% Sharpe 1.42）——
  // context.momentum = { rank, total, return12m } 由 buildWorkstationSnapshot 跨标的计算
  const mom = context.momentum || {};
  const rank = mom.rank ?? null;
  const total = mom.total ?? 0;
  const return12m = finite(mom.return12m, null);
  const momTop = rank !== null && rank <= Math.max(3, Math.ceil(total * 0.3)); // Top3 或前30%
  const momScore = rank === null ? 30 : 30 + clamp(Math.round((1 - rank / Math.max(1, total)) * 55), 0, 55);
  // —— 策略 2：波动率目标仓位（ATR% 预测波动，风控层：Sharpe 0.414→0.559 回撤减半）——
  const atrPct = daily.atrPct !== null ? daily.atrPct : (atrValue / price * 100);
  const atr20avg = daily.atr20Pct ?? atrPct; // 20日均值由 summarizeCandles 提供
  const volSpike = atr20avg > 0 ? atrPct / atr20avg : 1;
  const targetPos = volSpike > 0 ? Math.min(1, 0.6 / Math.max(0.15, volSpike)) : 0.5; // 目标年化波动~30%的简化仓位
  const volReady = atrPct > 0 && targetPos >= 0.4; // 波动不过高才可满仓
  return [
    signalLine({
      name: '12月动量选股',
      type: 'momentum_select',
      direction: momTop ? 'long' : 'neutral',
      ready: Boolean(momTop && liquidityOk && spreadOk),
      score: momScore,
      scoreBasis: [
        `基础规则 30`,
        rank !== null ? `12月动量排名 ${rank}/${total} +${Math.round((1 - rank / Math.max(1, total)) * 55)}` : '12月动量数据不足 +0',
        momTop ? '进入 Top 选股池 +10' : '未进 Top 选股池 +0',
      ],
      triggerDistancePct: null,
      evidence: [
        return12m !== null ? `过去12月收益 ${(return12m * 100).toFixed(1)}%（${mom.source === 'yahoo-daily-proxy' ? '现货代理' : 'OKX'}数据）` : '12月收益数据不足',
        rank !== null ? `横截面动量排名 ${rank}/${total}` : '不在现货代理池，无法横截面排名',
        '月度调仓：月末按动量重排 Top3-5（回测年化73% Sharpe 1.42）',
      ],
      blockers: [
        ...(rank === null ? ['不在现货代理池（Yahoo 5年日线），无法计算 12 月动量'] : []),
        ...(!momTop ? [`动量排名 ${rank ?? '--'}/${total ?? '--'}，未进入 Top 池`] : []),
      ],
    }),
    signalLine({
      name: '波动率目标仓位',
      type: 'vol_target',
      direction: 'neutral',
      ready: false,
      score: 20 + clamp(Math.round((1 - Math.min(2, volSpike)) * 40), 0, 40),
      scoreBasis: [
        `基础规则 20`,
        volSpike > 0 ? `ATR% ${atrPct.toFixed(2)} / 均值 ${atr20avg.toFixed(2)} = ${volSpike.toFixed(2)}x ${volSpike <= 1 ? '正常' : '偏高'}` : 'ATR 数据不足',
        `建议仓位 ${(targetPos * 100).toFixed(0)}%`,
      ],
      triggerDistancePct: null,
      evidence: [
        `ATR14% ${atrPct.toFixed(2)}%（预测未来波动 IC 0.28-0.41）`,
        volSpike > 1.5 ? '波动飙升：财报/宏观事件临近，建议降至半仓' : volSpike > 1 ? '波动略高于均值，适度减仓' : '波动正常，可满仓',
        '波动率目标仓位：高波减仓、低波满仓（回测 Sharpe +35%）',
      ],
      blockers: [
        ...(volSpike > 1.5 ? ['波动率高于均值 1.5 倍，风控建议降至半仓'] : []),
      ],
    }),
    signalLine({
      name: '4H短周期动量',
      type: 'short_momentum',
      direction: 'long',
      ready: Boolean(shortMom?.ready),
      score: shortMom ? 30 + clamp(Math.round(shortMom.momPct * 1000), 0, 60) : 20,
      scoreBasis: shortMom ? [`30根4H动量 ${(shortMom.momPct * 100).toFixed(2)}% ${shortMom.ready ? '≥1% 达标' : '未达1%阈值'}`] : ['4H K线不足30根'],
      triggerDistancePct: null,
      evidence: shortMom ? [`过去${momWin}根4H(≈5日)涨幅 ${(shortMom.momPct * 100).toFixed(2)}%`, '回测: 257笔净+62.5% 胜率65% 杠杆10x(样本短40天)'] : ['4H K线不足，无法计算短周期动量'],
      blockers: shortMom?.ready ? [] : ['4H 动量未达阈值或数据不足'],
    }),
  ].filter((signal) => {
    // 只保留已启用策略的信号（用户要求：停止旧策略）
    // context.enabledStrategies: 启用策略的 type 集合（如 ['short_momentum']）
    const enabled = context.enabledStrategies;
    if (!enabled || !enabled.length) return true; // 未传则全部保留（兼容测试）
    return enabled.includes(signal.type);
  });
}

function arbitrate(signals) {
  const ready = signals.filter((signal) => signal.status === 'ready' && signal.direction !== 'neutral');
  const longs = ready.filter((signal) => signal.direction === 'long');
  const shorts = ready.filter((signal) => signal.direction === 'short');
  if (longs.length >= 2 && shorts.length === 0) return { decision: 'final_long', label: '最终做多', direction: 'long', confidence: clamp(55 + longs.length * 12, 0, 92), confidenceLabel: '证据完整度', confidenceBasis: [`基础证据 55`, `${longs.length} 个多头策略同向 +${longs.length * 12}`, '空头冲突 0'], reason: '至少两个策略同向就绪，且无空头冲突' };
  if (shorts.length >= 2 && longs.length === 0) return { decision: 'final_short', label: '最终做空', direction: 'short', confidence: clamp(55 + shorts.length * 12, 0, 92), confidenceLabel: '证据完整度', confidenceBasis: [`基础证据 55`, `${shorts.length} 个空头策略同向 +${shorts.length * 12}`, '多头冲突 0'], reason: '至少两个策略同向就绪，且无多头冲突' };
  if (longs.length && shorts.length) return { decision: 'neutral', label: '观望', direction: 'neutral', confidence: 72, confidenceLabel: '观望证据完整度', confidenceBasis: [`多头就绪 ${longs.length}`, `空头就绪 ${shorts.length}`, '冲突门禁强制观望'], reason: '多空策略同时就绪，系统仲裁为冲突观望' };
  // 单策略就绪即可给出明确方向与价位（用户需要可执行的方向/进场/止盈止损，而非无意义的"关注/等待"）
  if (ready.length === 1) {
    const s = ready[0];
    const isLong = s.direction === 'long';
    return { decision: isLong ? 'final_long' : 'final_short', label: isLong ? '做多' : '做空', direction: isLong ? 'long' : 'short', confidence: clamp(50 + s.score * 0.3, 0, 85), confidenceLabel: '规则接近度', confidenceBasis: [`「${s.name}」就绪 ${s.score} 分`, '单一策略触发，方向明确', '得分非胜率'], reason: `「${s.name}」条件满足，方向${isLong ? '做多' : '做空'}` };
  }
  return { decision: 'wait', label: '观望', direction: 'neutral', confidence: 40, confidenceLabel: '证据完整度', confidenceBasis: ['没有策略达到 ready', '当前分数只表示规则接近程度', '不得解释为胜率'], reason: '没有策略达到可执行门槛' };
}

function buildPlan(instrument, snapshot, signals, arbitration, candleSet) {
  const candles = candleSet['1D']?.length ? candleSet['1D'] : candleSet['4H'] || candleSet.default || [];
  const summary = summarizeCandles(candles);
  const price = finite(snapshot?.last, finite(summary.current?.close, null));
  const tick = Math.max(finite(instrument.tickSize, 0.01), 0.000001);
  const atrValue = summary.atr14 || Math.max(price * 0.025, tick * 50);
  const direction = arbitration.direction;
  if (!price || direction === 'neutral') {
    return {
      status: 'incomplete',
      direction: 'neutral',
      reason: arbitration.reason,
      entryZone: null,
      stop: null,
      target1: null,
      target2: null,
      invalidation: '策略仲裁未通过，不生成交易预览',
      riskReward: null,
    };
  }
  const sign = direction === 'long' ? 1 : -1;
  const entryLow = direction === 'long' ? price - atrValue * 0.18 : price - atrValue * 0.45;
  const entryHigh = direction === 'long' ? price + atrValue * 0.45 : price + atrValue * 0.18;
  const stop = price - sign * atrValue * 1.12;
  const risk = Math.abs(price - stop);
  const target1 = price + sign * Math.max(risk * 1.6, price * 0.05);
  const target2 = price + sign * Math.max(risk * 2.7, price * 0.08);
  const toTick = (value) => Number((Math.round(value / tick) * tick).toFixed(Math.min(10, Math.max(0, String(tick).split('.')[1]?.length || 0))));
  const bestSignal = signals.filter((signal) => signal.status === 'ready').sort((a, b) => b.score - a.score)[0] || signals[0];
  return {
    status: arbitration.decision.startsWith('final') ? 'executable_plan' : 'watch_plan',
    direction,
    strategy: bestSignal?.name || '策略仲裁',
    entryZone: [toTick(entryLow), toTick(entryHigh)].sort((a, b) => a - b),
    stop: toTick(stop),
    target1: toTick(target1),
    target2: toTick(target2),
    riskReward: { target1R: pct(Math.abs(target1 - price) / risk), target2R: pct(Math.abs(target2 - price) / risk) },
    invalidation: direction === 'long' ? '日线收盘跌破入场结构低点或 RSI14 跌破 40' : '日线收盘站回入场结构高点或 RSI14 回到 60 以上',
    positionHint: { maxEquityPct: 5, riskPerTradePct: 1, stopDistancePct: pct(risk / price * 100), leverageNote: '按 USDT 名义金额计算，合约乘数和保证金以 OKX 返回为准' },
  };
}

function stateFromOpportunity(signals, arbitration) {
  if (arbitration.decision.startsWith('final')) return '可执行';
  if (arbitration.decision === 'watch') return '待确认';
  if (signals.some((signal) => signal.status === 'watch')) return '形成中';
  if (signals.some((signal) => signal.status === 'blocked')) return '阻塞';
  return '观察中';
}

function buildInstrumentDecision(row, context = {}) {
  const signals = buildSignals(row.instrument, row.snapshot, row.candleSet, context);
  const arbitration = arbitrate(signals);
  const plan = buildPlan(row.instrument, row.snapshot, signals, arbitration, row.candleSet);
  const score = Math.max(...signals.map((signal) => signal.score), 0) + (arbitration.decision.startsWith('final') ? 24 : arbitration.decision === 'watch' ? 10 : 0);
  const price = finite(row.snapshot?.last, null);
  const entryZone = plan.entryZone;
  const bestSignal = [...signals].sort((a, b) => b.score - a.score)[0];
  const planDistancePct = !price || !entryZone ? null : price < entryZone[0] ? (entryZone[0] / price - 1) * 100 : price > entryZone[1] ? (entryZone[1] / price - 1) * 100 : 0;
  const triggerDistancePct = planDistancePct ?? bestSignal?.triggerDistancePct ?? null;
  const triggerLabel = triggerDistancePct === null
    ? '等待策略参考位'
    : entryZone
      ? triggerDistancePct === 0 ? '现价已进入入场区' : `距入场区 ${triggerDistancePct > 0 ? '+' : ''}${triggerDistancePct.toFixed(2)}%`
      : `距「${bestSignal?.name || '最佳策略'}」参考位 ${triggerDistancePct > 0 ? '+' : ''}${triggerDistancePct.toFixed(2)}%`;
  const arbitrationBonus = arbitration.decision.startsWith('final') ? 24 : arbitration.decision === 'watch' ? 10 : 0;
  return {
    instId: row.instrument.instId,
    underlying: row.instrument.underlying,
    displayName: row.instrument.displayName,
    assetClass: row.instrument.assetClass,
    price,
    change24h: pct(finite(row.snapshot?.change24h, 0)),
    volume24h: finite(row.snapshot?.volume24h, 0),
    source: row.snapshot?.source || 'waiting',
    sourceTs: row.snapshot?.sourceTs || null,
    recvTs: row.snapshot?.recvTs || null,
    state: stateFromOpportunity(signals, arbitration),
    score: clamp(score, 0, 100),
    scoreLabel: '规则接近度',
    scoreBasis: [`最佳策略「${bestSignal?.name || '无'}」${bestSignal?.score || 0} 分`, `${arbitrationBonus ? `仲裁状态加 ${arbitrationBonus}` : '仲裁未加分'}`, '不是预测胜率'],
    trigger: {
      distancePct: pct(triggerDistancePct),
      label: triggerLabel,
      blockers: [...new Set(signals.flatMap((signal) => signal.blockers || []))].slice(0, 6),
    },
    funding: row.snapshot?.funding || null,
    momentum: (context.momentum && (context.momentum.rank !== null || context.momentum.rank !== undefined)) ? {
      rank: context.momentum.rank,
      total: context.momentum.total,
      return12m: context.momentum.return12m,
      source: context.momentum.source || 'okx',
    } : null,
    signals,
    arbitration,
    plan,
  };
}

function dedupeTopEquities(decisions) {
  const seen = new Set();
  const output = [];
  for (const item of decisions.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))) {
    const key = String(item.underlying || item.instId).replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= 5) break;
  }
  return output.sort((a, b) => b.score - a.score);
}

export function buildWorkstationSnapshot({ instruments = [], marketItems = [], candleSets = {}, connection = {}, risk = {}, privateData = {}, marketEvents = {}, liveTrading = false, nowMs = Date.now(), momentumRank = null, enabledStrategies = null } = {}) {
  const snapshotById = new Map(marketItems.map((item) => [item.instId, item]));
  const tradfi = instruments.filter((instrument) => instrument.assetClass === 'equity' && String(instrument.instId).endsWith('-USDT-SWAP'));
  const rows = tradfi.map((instrument) => ({
    instrument,
    snapshot: snapshotById.get(instrument.instId) || {},
    candleSet: candleSets[instrument.instId] || { default: [] },
  })).filter((row) => row.instrument.instId);
  // —— 横截面 12 月动量排名 ——
  // 方案B：OKX 永续历史不足 260 根，改用 Yahoo 现货日线代理（EquityMomentumSource）
  // 映射：NVDA-USDT-SWAP → NVDA 现货；无映射的标的(如 SNXX)无排名，显示"不在现货池"
  const momentumMap = new Map();
  if (momentumRank && momentumRank.size) {
    for (const [instId, inst] of rows.map((r) => [r.instrument.instId, r.instrument])) {
      const sym = String(instId).replace(/-USDT-SWAP$/, '');
      const mom = momentumRank.get(sym);
      if (mom) momentumMap.set(instId, { ...mom, source: 'yahoo-daily-proxy' });
    }
  }
  const decisions = rows.map((row) => buildInstrumentDecision(row, { momentum: momentumMap.get(row.instrument.instId) || null, enabledStrategies }));
  // 只保留有现货代理动量的标的：无排名的（不在代理池/数据不足）不进入机会列表，避免"K线不足"鸡肋
  const decisionsWithMomentum = decisions.filter((item) => {
    const momSignal = (item.signals || []).find((s) => s.type === 'momentum_select');
    return momSignal && momSignal.scoreBasis && momSignal.scoreBasis.some((b) => b.includes('排名'));
  });
  const opportunities = dedupeTopEquities(decisionsWithMomentum.length ? decisionsWithMomentum : decisions);
  // —— 交易员视角：标注已持仓标的，避免同向重复推荐诱导加仓 ——
  const heldPositions = (privateData.positions || []).filter((p) => Number(p.quantity) !== 0);
  const heldByInst = new Map();
  for (const p of heldPositions) {
    const existing = heldByInst.get(p.instId) || [];
    existing.push({ side: p.side, qty: Math.abs(Number(p.quantity)) });
    heldByInst.set(p.instId, existing);
  }
  for (const opp of opportunities) {
    const held = heldByInst.get(opp.instId);
    if (held?.length) {
      const heldLong = held.some((h) => h.side === 'long');
      const heldShort = held.some((h) => h.side === 'short');
      opp.held = { sides: held.map((h) => h.side), totalQty: held.reduce((s, h) => s + h.qty, 0) };
      // 同向重复推荐 → 标记为"已持仓"，降权提示
      if ((opp.arbitration?.direction === 'long' && heldLong) || (opp.arbitration?.direction === 'short' && heldShort)) {
        opp.held.sameDirection = true;
        opp.score = Math.round(opp.score * 0.85); // 降权，避免诱导加仓
        opp.scoreBasis = [...(opp.scoreBasis || []), '已持仓同向，降权 15% 避免诱导加仓'];
      } else if (opp.arbitration?.direction && (opp.arbitration.direction === 'long' ? heldShort : heldLong)) {
        opp.held.opposite = true; // 反向持仓 → 可能是减仓/平仓机会
      }
    }
  }
  const session = marketSession(nowMs);
  const readyCount = decisions.filter((item) => item.arbitration.decision.startsWith('final')).length;
  const connected = connection.status === 'connected';
  const stale = connection.lastMessageAt ? Date.now() - Date.parse(connection.lastMessageAt) > 60_000 : !connected;
  const atrSamples = decisions.map((item) => item.plan?.positionHint?.stopDistancePct).filter((value) => value !== null);
  const avgAtrRisk = atrSamples.length ? atrSamples.reduce((sum, value) => sum + value, 0) / atrSamples.length : null;
  const historyReady = rows.filter((row) => (row.candleSet['1D'] || []).length >= 50).length;
  const historyCoverage = rows.length ? historyReady / rows.length : 0;
  const confidenceParts = [connected ? 35 : 0, connected && !stale ? 25 : 0, Math.round(historyCoverage * 25), readyCount ? 15 : 0];
  const marketConfidence = confidenceParts.reduce((sum, value) => sum + value, 0);
  const fundingItems = opportunities.map((item) => item.funding).filter((item) => Number.isFinite(Number(item?.fundingRate)));
  const nextMacro = (marketEvents.macro || []).filter((event) => Date.parse(event.time) >= nowMs).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0];
  const nextEarnings = (marketEvents.earnings || []).filter((event) => Date.parse(event.time) >= nowMs).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0];
  const marketState = {
    label: readyCount >= 2 ? '有筛选后的可交易机会' : connected && !stale ? '观察为主，等待策略同向确认' : '数据不完整，禁止执行',
    confidence: clamp(marketConfidence, 0, 100),
    confidenceLabel: '数据与决策证据完整度',
    confidenceBasis: [`公共WS ${connected ? '+35' : '+0'}`, `行情新鲜度 ${connected && !stale ? '+25' : '+0'}`, `日线历史覆盖 ${historyReady}/${rows.length} +${confidenceParts[2]}`, `可执行机会 ${readyCount} +${readyCount ? 15 : 0}`],
    session,
    generatedAt: new Date(nowMs).toISOString(),
    beijingTime: BEIJING_FORMAT.format(new Date(nowMs)),
    dataHealth: [
      { source: 'OKX 公共 WS', state: connected && !stale ? 'live' : connected ? 'stale' : connection.status || 'disconnected', updatedAt: connection.lastMessageAt || null, message: connection.message || '等待连接' },
      { source: 'OKX Business K线', state: connected ? 'live/partial' : 'waiting', updatedAt: connection.lastMessageAt || null, message: 'confirm=0 更新末根，confirm=1 追加确认K线' },
      { source: 'OKX 私有 WS', state: privateData.source === 'okx-private-ws' ? 'live' : 'waiting', updatedAt: privateData.generatedAt || null, message: privateData.source === 'okx-private-ws' ? '订单/成交/持仓来自私有订阅' : '等待账户绑定或私有连接' },
      { source: 'MySQL 历史库', state: Object.values(candleSets).some((set) => Object.values(set).some((items) => items?.some((item) => String(item.source || '').includes('mysql')))) ? 'live' : 'partial', updatedAt: null, message: '历史K线按 instId+周期 入库，可重算复盘' },
    ],
    breadth: {
      discovered: instruments.length,
      equities: tradfi.length,
      executable: readyCount,
      avgAtrStopPct: pct(avgAtrRisk),
    },
    trendMatrix: opportunities.slice(0, 6).map((item) => ({
      underlying: item.underlying,
      day: item.signals[0]?.direction === 'long' ? '多头' : item.signals[0]?.direction === 'short' ? '空头' : '震荡',
      fourHour: item.signals[1]?.status === 'ready' ? '接近触发' : '等待',
      decision: item.arbitration.label,
    })),
    macro: [
      { name: 'CPI / 非农 / FOMC', state: nextMacro ? 'live' : (marketEvents.macroState === 'error' ? 'error' : 'empty'), action: nextMacro ? `${new Date(nextMacro.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · ${nextMacro.title} · ${nextMacro.impact}` : (marketEvents.macroState === 'error' ? `宏观数据源暂不可用${marketEvents.errors?.filter((e) => e.includes('宏观')).map((e) => `（${e}）`).join('') || ''}` : '本周无美国高影响宏观事件') },
      { name: '财报日历', state: nextEarnings ? 'live' : (marketEvents.earningsState === 'error' ? 'error' : 'empty'), action: nextEarnings ? `${new Date(nextEarnings.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · ${nextEarnings.title}` : (marketEvents.earningsState === 'error' ? `财报数据源暂不可用${marketEvents.errors?.filter((e) => e.includes('财报')).map((e) => `（${e}）`).join('') || ''}` : '未来7天无财报事件') },
      { name: 'OKX 资金费', state: fundingItems.length ? 'live' : connected ? 'partial' : 'disconnected', action: fundingItems.length ? fundingItems.map((item) => `${item.instId} ${(Number(item.fundingRate) * 100).toFixed(4)}%`).join(' · ') : 'OKX 暂未向当前候选返回 funding-rate，预检继续使用保守成本上限' },
    ],
  };
  const riskCenter = {
    state: risk.state || 'normal',
    equity: finite(risk.equity, 0),
    available: finite(risk.available, 0),
    todayPnl: finite(risk.todayPnl, 0),
    drawdownPct: finite(risk.drawdownPct, 0),
    openPositions: finite(risk.openPositions, 0),
    grossExposure: finite(risk.grossExposure, 0),
    breakers: [
      { key: 'daily_loss', name: '单日亏损', status: risk.todayPnl <= risk.dailyLossLimit ? 'halted' : 'normal', current: risk.todayPnl || 0, limit: risk.dailyLossLimit || 0, action: '触发后停止新开仓' },
      { key: 'drawdown', name: '最大回撤', status: risk.drawdownPct >= 15 ? 'restricted' : 'normal', current: risk.drawdownPct || 0, limit: 15, action: '15% 后只管理现有仓位' },
      { key: 'system_health', name: '数据健康', status: connected && !stale ? 'normal' : 'halted', current: connected ? 1 : 0, limit: 1, action: '行情断联或过期时清空执行态' },
    ],
    events: risk.recentEvents || [],
  };
  const review = buildReview(privateData);
  return {
    version: 'v3',
    mode: liveTrading ? 'live-data-live-execution' : 'live-data-safe-execution-off',
    nav: ['机会', '驾驶舱', '实盘', '复盘', '设置'],
    marketState,
    opportunities,
    selected: opportunities[0] || decisions[0] || null,
    strategyCouncil: opportunities.map((item) => ({ instId: item.instId, underlying: item.underlying, arbitration: item.arbitration, signals: item.signals })),
    plans: opportunities.map((item) => ({ instId: item.instId, underlying: item.underlying, plan: item.plan })),
    riskCenter,
    execution: {
      liveTrading: Boolean(liveTrading),
      source: privateData.source || 'waiting-okx-account',
      orders: privateData.exchangeOrders || [],
      fills: privateData.fills || [],
      positions: privateData.positions || [],
      guardrails: ['预览 → 二次确认 → 写入订单意图', 'clOrdId 幂等', liveTrading ? '风控通过且二次确认后发送 OKX 实盘订单' : '实盘开关关闭时绝不发送 OKX 订单', '系统不实现任何提现接口'],
    },
    review,
  };
}

export function buildReview(privateData = {}) {
  const fills = Array.isArray(privateData.fills) ? privateData.fills : [];
  const orders = Array.isArray(privateData.exchangeOrders) ? privateData.exchangeOrders : [];
  const daily = privateData.review || { summary: {}, attribution: [], trades: [], nextActions: [] };
  const fees = finite(daily.summary?.totalFees, fills.reduce((sum, fill) => sum + Math.abs(finite(fill.fee, 0)), 0));
  const estimatedPnl = finite(daily.summary?.pnl, null);
  const pairedTrades = Array.isArray(daily.trades) ? daily.trades : [];
  const hasTradeFacts = fills.length > 0 || orders.some((order) => finite(order.pnl, 0) !== 0);
  const hasPairedTrades = pairedTrades.length > 0;
  return {
    state: hasPairedTrades ? 'estimated_unreconciled' : hasTradeFacts ? 'waiting_pairing' : 'waiting_fills',
    reconciled: false,
    date: daily.date || null,
    reconciliation: hasPairedTrades ? '估算值：来自 OKX 成交 FIFO 配对，尚未与账单和资金费逐笔对平' : hasTradeFacts ? '已读取 OKX 成交，但今日尚未形成完整开平配对' : '没有 OKX 成交事实，不生成虚假盈亏报告',
    summary: {
      netPnl: null,
      estimatedNetPnl: hasPairedTrades ? pct(estimatedPnl) : null,
      totalFees: pct(fees),
      fillCount: fills.length,
      orderCount: orders.length,
      pairedTradeCount: pairedTrades.length,
      expectancy: hasPairedTrades ? pct(daily.summary.expectancy) : null,
      winRate: hasPairedTrades ? pct(daily.summary.winRate * 100) : null,
      profitFactor: hasPairedTrades ? pct(daily.summary.profitFactor) : null,
      maxDrawdown: hasPairedTrades ? pct(daily.summary.maxDrawdown) : null,
    },
    attribution: (daily.attribution || []).map((item) => ({ ...item, pnl: pct(item.pnl), insight: item.pnl >= 0 ? '该维度的已配对成交贡献为正，仍待账单对平' : '该维度拖累估算收益，需要复查入场与执行成本' })),
    trades: pairedTrades,
    tradeFields: ['R倍数', 'MFE', 'MAE', 'VWAP滑点', 'Implementation Shortfall', '手续费', '资金费', '计划偏差', '持仓时长', '纪律标签'],
    dailyFields: ['净利', '胜率', '盈亏比', '期望', '回撤', '资金曲线', '策略贡献', '标的贡献', '美股时段分桶', 'ATR分桶', '拒单/断线/风控事件'],
    nextActions: hasTradeFacts
      ? ['接入 OKX 账单流水与资金费后做逐笔对平', ...(daily.nextActions || []), '把偏离计划的成交推送到纪律检查']
      : ['等待 OKX fills 或历史账单入库', '没有成交时只显示复盘模板和验收缺口', '禁止用演示订单冒充真实复盘'],
  };
}
