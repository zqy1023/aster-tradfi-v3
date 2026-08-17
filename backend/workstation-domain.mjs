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
  return { count: clean.length, current, closes, atr14, atrPct, ema20, ema50, rsi14, adx14, vwap20, high20, low20 };
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

function buildSignals(instrument, snapshot, candleSet) {
  const daily = summarizeCandles(candleSet['1D']?.length ? candleSet['1D'] : candleSet['4H'] || candleSet.default || []);
  const fourHour = summarizeCandles(candleSet['4H']?.length ? candleSet['4H'] : candleSet.default || []);
  const price = finite(snapshot?.last, finite(daily.current?.close, null));
  if (!price || daily.count < 20) {
    return [
      signalLine({
        name: '突破回踩确认',
        type: 'breakout_retest',
        direction: 'neutral',
        ready: false,
        score: 12,
        scoreBasis: ['数据可用性基础分 12；K线不足，不叠加任何策略分'],
        triggerDistancePct: null,
        evidence: ['历史 K 线不足，不能生成可执行策略证据'],
        blockers: ['等待 OKX 历史 K 线补齐到至少 20 根'],
      }),
    ];
  }
  const atrValue = daily.atr14 || Math.max(price * 0.025, Number(instrument.tickSize || 0.01) * 20);
  const liquidityOk = finite(snapshot?.volume24h, 0) > 0 || snapshot?.source === 'demo-snapshot';
  const adxOk = (daily.adx14 || fourHour.adx14 || 0) >= 14;
  const spreadBps = snapshot?.bid && snapshot?.ask ? (snapshot.ask - snapshot.bid) / price * 10_000 : null;
  const spreadOk = spreadBps === null || spreadBps <= 35;
  // —— 策略 1：突破回踩确认 ——
  const brokeHigh = daily.high20 && price > daily.high20;
  const brokeLow = daily.low20 && price < daily.low20;
  const retestLong = brokeHigh && fourHour.close && price >= fourHour.close - (fourHour.atr14 || atrValue) * 1.0 && price <= fourHour.close + (fourHour.atr14 || atrValue) * 0.3;
  const retestShort = brokeLow && fourHour.close && price <= fourHour.close + (fourHour.atr14 || atrValue) * 1.0 && price >= fourHour.close - (fourHour.atr14 || atrValue) * 0.3;
  const retestBreakoutLong = brokeHigh && retestLong;
  const retestBreakoutShort = brokeLow && retestShort;
  // —— 策略 2：动量延续跟随 ——
  const ema20Slope = daily.ema20 && daily.closes.length >= 22 ? daily.ema20 - ema(daily.closes.slice(0, -1), 20) : null;
  const newHigh10 = daily.closes && daily.closes.length >= 12 ? price > Math.max(...daily.closes.slice(-11, -1)) : false;
  const newLow10 = daily.closes && daily.closes.length >= 12 ? price < Math.min(...daily.closes.slice(-11, -1)) : false;
  const momentumLong = ema20Slope !== null && ema20Slope > 0 && newHigh10 && (daily.adx14 || 0) >= 20;
  const momentumShort = ema20Slope !== null && ema20Slope < 0 && newLow10 && (daily.adx14 || 0) >= 20;
  // —— 策略 3：区间高抛低吸 ——
  const rangeBoundLong = daily.low20 && daily.high20 && daily.adx14 !== null && daily.adx14 < 16 && price <= daily.low20 + (daily.high20 - daily.low20) * 0.25 && (daily.rsi14 || 50) <= 38;
  const rangeBoundShort = daily.low20 && daily.high20 && daily.adx14 !== null && daily.adx14 < 16 && price >= daily.high20 - (daily.high20 - daily.low20) * 0.25 && (daily.rsi14 || 50) >= 62;
  return [
    signalLine({
      name: '突破回踩确认',
      type: 'breakout_retest',
      direction: retestBreakoutLong ? 'long' : retestBreakoutShort ? 'short' : brokeHigh ? 'long' : brokeLow ? 'short' : 'neutral',
      ready: Boolean((retestBreakoutLong || retestBreakoutShort) && liquidityOk && spreadOk),
      score: 40 + (brokeHigh || brokeLow ? 20 : 0) + (retestLong || retestShort ? 22 : 0) + (adxOk ? 10 : 0),
      scoreBasis: [`基础规则 40`, `${brokeHigh || brokeLow ? '已突破20日边界 +20' : '未突破边界 +0'}`, `${retestLong || retestShort ? '4H回踩企稳 +22' : '未回踩企稳 +0'}`, `${adxOk ? '趋势强度达标 +10' : '趋势强度不足 +0'}`],
      triggerDistancePct: brokeHigh && daily.high20 ? distancePct(price, daily.high20) : brokeLow && daily.low20 ? distancePct(price, daily.low20) : daily.high20 ? distancePct(price, daily.high20) : null,
      evidence: [
        brokeHigh ? '日线已突破 20 日上沿，等待 4H 回踩' : brokeLow ? '日线已跌破 20 日下沿，等待 4H 回抽' : '尚未突破 20 日边界',
        `4H 收盘 ${fourHour.close ? fourHour.close.toFixed(4) : '不足'}，ATR ${fourHour.atr14 ? fourHour.atr14.toFixed(4) : '不足'}`,
        retestBreakoutLong || retestBreakoutShort ? '回踩已进入确认区' : '回踩未达确认区',
      ],
      blockers: [
        ...(!(brokeHigh || brokeLow) ? ['价格尚未突破 20 日区间边界'] : []),
        ...(!(retestLong || retestShort) ? ['4H 回踩尚未到位'] : []),
      ],
    }),
    signalLine({
      name: '动量延续跟随',
      type: 'momentum_follow',
      direction: momentumLong ? 'long' : momentumShort ? 'short' : ema20Slope !== null && ema20Slope > 0 ? 'long' : ema20Slope !== null && ema20Slope < 0 ? 'short' : 'neutral',
      ready: Boolean((momentumLong || momentumShort) && liquidityOk && spreadOk),
      score: 40 + (newHigh10 || newLow10 ? 24 : 0) + (ema20Slope !== null && ema20Slope > 0 || ema20Slope !== null && ema20Slope < 0 ? 16 : 0) + ((daily.adx14 || 0) >= 20 ? 12 : 0),
      scoreBasis: [`基础规则 40`, `${newHigh10 || newLow10 ? '创10日新高/低 +24' : '未创新高/低 +0'}`, `${ema20Slope !== null && ema20Slope > 0 || ema20Slope !== null && ema20Slope < 0 ? 'EMA20斜率同向 +16' : 'EMA20斜率不足 +0'}`, `${(daily.adx14 || 0) >= 20 ? 'ADX强劲 +12' : 'ADX不足 +0'}`],
      triggerDistancePct: daily.ema20 ? distancePct(price, daily.ema20) : null,
      evidence: [
        `EMA20 斜率 ${ema20Slope !== null ? (ema20Slope > 0 ? '向上' : '向下') : '不足'}，ADX14 ${daily.adx14 ? daily.adx14.toFixed(1) : '不足'}`,
        newHigh10 ? '已创 10 日新高，动量延续' : newLow10 ? '已创 10 日新低，动量延续' : '未创 10 日新高/低',
        '顺势跟随，不预测反转',
      ],
      blockers: [
        ...(!(newHigh10 || newLow10) ? ['尚未创 10 日新高/低'] : []),
        ...(!((daily.adx14 || 0) >= 20) ? ['ADX 未达 20，动量强度不足'] : []),
      ],
    }),
    signalLine({
      name: '区间高抛低吸',
      type: 'range_mean',
      direction: rangeBoundLong ? 'long' : rangeBoundShort ? 'short' : 'neutral',
      ready: Boolean((rangeBoundLong || rangeBoundShort) && liquidityOk && spreadOk),
      score: 35 + (rangeBoundLong || rangeBoundShort ? 30 : 0) + (daily.adx14 !== null && daily.adx14 < 16 ? 15 : 0),
      scoreBasis: [`基础规则 35`, `${rangeBoundLong || rangeBoundShort ? '触及区间分位 +30' : '未触及分位 +0'}`, `${daily.adx14 !== null && daily.adx14 < 16 ? '无趋势确认 +15' : 'ADX过高 +0'}`],
      triggerDistancePct: daily.high20 && daily.low20 ? (price - daily.low20) / (daily.high20 - daily.low20) * 100 : null,
      evidence: [
        `20 日区间 ${daily.low20 ? daily.low20.toFixed(4) : '不足'} - ${daily.high20 ? daily.high20.toFixed(4) : '不足'}`,
        `ADX14 ${daily.adx14 ? daily.adx14.toFixed(1) : '不足'}，RSI14 ${daily.rsi14 ? daily.rsi14.toFixed(1) : '不足'}`,
        rangeBoundLong ? '价格在区间下沿，等待反弹' : rangeBoundShort ? '价格在区间上沿，等待回落' : '价格在区间中部',
      ],
      blockers: [
        ...(daily.adx14 !== null && daily.adx14 >= 16 ? ['ADX 过高，趋势行情不适合高抛低吸'] : []),
        ...(!(rangeBoundLong || rangeBoundShort) ? ['价格未触及区间分位'] : []),
      ],
    }),
  ];
}

function arbitrate(signals) {
  const ready = signals.filter((signal) => signal.status === 'ready' && signal.direction !== 'neutral');
  const longs = ready.filter((signal) => signal.direction === 'long');
  const shorts = ready.filter((signal) => signal.direction === 'short');
  if (longs.length >= 2 && shorts.length === 0) return { decision: 'final_long', label: '最终做多', direction: 'long', confidence: clamp(55 + longs.length * 12, 0, 92), confidenceLabel: '证据完整度', confidenceBasis: [`基础证据 55`, `${longs.length} 个多头策略同向 +${longs.length * 12}`, '空头冲突 0'], reason: '至少两个策略同向就绪，且无空头冲突' };
  if (shorts.length >= 2 && longs.length === 0) return { decision: 'final_short', label: '最终做空', direction: 'short', confidence: clamp(55 + shorts.length * 12, 0, 92), confidenceLabel: '证据完整度', confidenceBasis: [`基础证据 55`, `${shorts.length} 个空头策略同向 +${shorts.length * 12}`, '多头冲突 0'], reason: '至少两个策略同向就绪，且无多头冲突' };
  if (longs.length && shorts.length) return { decision: 'neutral', label: '观望', direction: 'neutral', confidence: 72, confidenceLabel: '观望证据完整度', confidenceBasis: [`多头就绪 ${longs.length}`, `空头就绪 ${shorts.length}`, '冲突门禁强制观望'], reason: '多空策略同时就绪，系统仲裁为冲突观望' };
  if (ready.length === 1) return { decision: 'watch', label: '关注', direction: ready[0].direction, confidence: 48, confidenceLabel: '证据完整度', confidenceBasis: ['仅 1 个策略就绪', '缺少第二个同向确认', '不得解释为胜率'], reason: '只有一个策略就绪，等待第二确认' };
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

function buildInstrumentDecision(row) {
  const signals = buildSignals(row.instrument, row.snapshot, row.candleSet);
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

export function buildWorkstationSnapshot({ instruments = [], marketItems = [], candleSets = {}, connection = {}, risk = {}, privateData = {}, marketEvents = {}, liveTrading = false, nowMs = Date.now() } = {}) {
  const snapshotById = new Map(marketItems.map((item) => [item.instId, item]));
  const tradfi = instruments.filter((instrument) => instrument.assetClass === 'equity' && String(instrument.instId).endsWith('-USDT-SWAP'));
  const rows = tradfi.map((instrument) => ({
    instrument,
    snapshot: snapshotById.get(instrument.instId) || {},
    candleSet: candleSets[instrument.instId] || { default: [] },
  })).filter((row) => row.instrument.instId);
  const decisions = rows.map(buildInstrumentDecision);
  const opportunities = dedupeTopEquities(decisions);
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
      { name: 'CPI / 非农 / FOMC', state: nextMacro ? 'live' : marketEvents.state || 'disconnected', action: nextMacro ? `${new Date(nextMacro.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · ${nextMacro.title} · ${nextMacro.impact}` : `本周无匹配事件${marketEvents.errors?.length ? `；${marketEvents.errors.join('；')}` : ''}` },
      { name: '财报日历', state: nextEarnings ? 'live' : marketEvents.state || 'disconnected', action: nextEarnings ? `${new Date(nextEarnings.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · ${nextEarnings.title}` : '未来7天当前候选池未发现财报事件' },
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
