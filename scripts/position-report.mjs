// 持仓分析报告 v5：仓位 = 风险预算 × 方向确信度系数
// 方向越明确(动量排名靠前/趋势信号ready/波动正常) → 仓位系数越大
import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4319';
const PASS = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();

async function login() {
  const resp = await fetch(`${BASE}/api/v3/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  const jar = (resp.headers.get('set-cookie') || '').split(';')[0];
  if (!jar) throw new Error('登录失败');
  return jar;
}
async function api(cookie, path) {
  const resp = await fetch(`${BASE}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  if (resp.status === 401) throw new Error('会话过期');
  return resp.json();
}

const jar = await login();
const [orders, risk, ws, algoPayload] = await Promise.all([
  api(jar, '/api/v3/orders'),
  api(jar, '/api/v3/risk/overview'),
  api(jar, '/api/v3/workstation'),
  api(jar, '/api/v3/positions/algos').catch(() => ({ algos: [] })),
]);
const positions = orders.positions || [];
const algos = algoPayload.algos || [];
const algosByInst = new Map();
for (const algo of algos) {
  const list = algosByInst.get(algo.instId) || [];
  list.push(algo);
  algosByInst.set(algo.instId, list);
}
const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const equity = Number(risk?.equity || 0);
const oppByInst = new Map((ws.opportunities || []).map(o => [o.instId, o]));

// 方向确信度模型：动量排名 + 信号就绪 + 波动率状态 → 仓位系数
// 基础风险预算 2% 权益（方向不明时）→ 方向明确时放大
function convictionFor(instId) {
  const opp = oppByInst.get(instId);
  if (!opp) return { level: '未知', mult: 1, basis: ['无策略信号数据'] };
  const mom = opp.momentum;
  const signals = opp.signals || [];
  const momSig = signals.find(s => s.type === 'momentum_select');
  const volSig = signals.find(s => s.type === 'vol_target');
  const basis = [];
  let mult = 1, level = '中性';

  // 动量排名 → 核心系数
  if (mom && mom.rank && mom.total) {
    const pct = mom.rank / mom.total; // 排名分位(越小越强)
    if (pct <= 0.1) { mult *= 2.5; level = '强烈'; basis.push(`动量 #${mom.rank}/${mom.total}（前10%，最强档）`); }
    else if (pct <= 0.3) { mult *= 2.0; level = '明确'; basis.push(`动量 #${mom.rank}/${mom.total}（前30%）`); }
    else if (pct <= 0.5) { mult *= 1.5; level = '中等'; basis.push(`动量 #${mom.rank}/${mom.total}（前50%）`); }
    else { mult *= 0.8; level = '偏弱'; basis.push(`动量 #${mom.rank}/${mom.total}（后50%，方向存疑）`); }
  }
  // 信号就绪状态
  if (momSig?.status === 'ready' && momSig.direction !== 'neutral') { mult *= 1.3; basis.push(`「${momSig.name}」就绪 ${momSig.score}分`); }
  else if (momSig?.status === 'blocked') { mult *= 0.5; basis.push('动量信号受阻，方向未确认'); }
  // 波动率状态：高波动降仓
  if (volSig) {
    const ev = (volSig.evidence || []).join(' ');
    if (ev.includes('波动飙升')) { mult *= 0.5; basis.push('波动飙升，降仓'); }
    else if (ev.includes('略高于')) { mult *= 0.8; basis.push('波动偏高，适度降仓'); }
    else if (ev.includes('正常')) { basis.push('波动正常'); }
  }
  return { level, mult: Math.round(mult * 10) / 10, basis };
}

const lines = [];
lines.push(`📊 持仓分析 · ${now}`);
lines.push('━━━━━━━━━━━━━━━━');

if (!positions.length) {
  lines.push('📭 当前无持仓');
} else {
  for (const p of positions) {
    const side = p.side === 'long' ? '多' : '空';
    const entry = Number(p.avgEntryPrice), mark = Number(p.markPrice), qty = Math.abs(Number(p.quantity));
    const upl = Number(p.unrealizedPnl || 0), lev = Number(p.leverage || 1), liq = Number(p.liquidationPrice);
    const raw = p.raw || {};
    const nativeAlgo = (raw.closeOrderAlgo || [])[0] || {};
    const positionAlgos = algosByInst.get(p.instId) || [];
    const trailing = positionAlgos.find((a) => a.ordType === 'move_order_stop' || Number(a.callbackRatio) > 0) || null;
    const conditional = positionAlgos.filter((a) => a.ordType === 'conditional' || Number(a.slTriggerPx) || Number(a.tpTriggerPx));
    const sl = Number(nativeAlgo.slTriggerPx || conditional.find(a => Number(a.slTriggerPx))?.slTriggerPx || 0);
    const tp = Number(nativeAlgo.tpTriggerPx || conditional.find(a => Number(a.tpTriggerPx))?.tpTriggerPx || 0);
    const holdMin = Math.round((Date.now() - (Date.parse(p.sourceTs || p.recvTs) || Date.now())) / 60000);
    const pct = entry ? (mark - entry) / entry * 100 * (side === '多' ? 1 : -1) : 0;

    // 数学
    const lossPerUnit = Math.abs(entry - sl);
    const curRisk = lossPerUnit * qty;
    const curRiskPct = equity ? curRisk / equity * 100 : 0;
    const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;
    const distSl = mark && sl ? Math.abs(mark - sl) / mark * 100 : null;

    // 方向确信度 → 建议仓位
    const conv = convictionFor(p.instId);
    const baseRiskPct = 2;                                    // 基础风险预算 2% 权益
    const targetRiskPct = baseRiskPct * conv.mult;            // 方向放大后的目标风险上限
    const targetQty = equity * targetRiskPct / 100 / lossPerUnit; // 目标可持仓
    const sellQty = Math.max(0, qty - targetQty);
    const over = curRiskPct > targetRiskPct * 1.2;            // 超 20% 视为超配

    // 风险等级（结合方向：方向明确时容忍更高风险）
    // 关键: 有止损保护 → 最大亏损是确定的(止损触发即离场), 清算永远不会触发
    // 只要止损 < 清算距离, 按"最大确定亏损"评估而非机械报超配
    const stopProtects = sl && liq && (side === '多' ? sl > liq : sl < liq); // 止损比清算更近
    let level, verdict;
    if (liq && distLiq !== null && distLiq < 2 && !stopProtects) { level = '🔴 高危'; verdict = '距清算不足 2% 且止损未保护，随时可能爆仓'; }
    else if (stopProtects && curRiskPct <= targetRiskPct * 1.5) {
      level = '🟢 合理'; verdict = `止损保护有效：最大确定亏损 ${curRiskPct.toFixed(1)}% 权益（止损 ${sl.toFixed(2)} 先于清算 ${liq?.toFixed(0) || '--'} 触发），方向确信度 ${conv.level} 支持持有`;
    }
    else if (stopProtects) {
      level = '🟡 偏重'; verdict = `止损保护有效，但最大亏损 ${curRiskPct.toFixed(1)}% 高于方向上限 ${targetRiskPct.toFixed(1)}%`;
    }
    else if (over) { level = '🟠 超配'; verdict = `仓位超过方向确信度对应的上限（现 ${curRiskPct.toFixed(1)}% vs 应 ≤${targetRiskPct.toFixed(1)}%）`; }
    else { level = '🟢 合理'; verdict = `仓位符合方向确信度（现 ${curRiskPct.toFixed(1)}% ≤ 上限 ${targetRiskPct.toFixed(1)}%）`; }

    const reasons = [];
    reasons.push(`方向确信度 ${conv.level} ×${conv.mult}（${conv.basis.join('、')}）`);
    reasons.push(`距清算 ${distLiq?.toFixed(2) || '--'}%（清算价 ${liq?.toFixed(0) || '--'}）`);
    if (sl) reasons.push(`止损 ${sl.toFixed(2)}（距现价 ${distSl?.toFixed(2)}%）`);
    reasons.push(`止损触发亏 ${curRiskPct.toFixed(1)}% 权益`);
    reasons.push(`浮${upl >= 0 ? '盈' : '亏'} ${upl >= 0 ? '+' : ''}${upl.toFixed(2)}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）· 开仓 ${holdMin} 分钟`);
    if (tp) { const rr = Math.abs(tp - entry) / Math.max(lossPerUnit, 0.0001); if (rr > 5) reasons.push(`止盈 ${tp.toFixed(0)} 盈亏比 ${rr.toFixed(1)}:1 目标过远`); }

    // 建议
    const actions = [];
    if (liq && distLiq !== null && distLiq < 2 && !stopProtects) actions.push(`立即降杠杆：距清算 <2% 且无止损保护，先活下来`);
    else if (stopProtects && curRiskPct <= targetRiskPct * 1.5) {
      actions.push(`持有：止损 ${sl.toFixed(2)} 已锁死最大亏损 ${curRiskPct.toFixed(1)}% 权益，清算不会触发`);
      if (!tp) actions.push(`挂止盈：方向动量强，建议目标 +8~10%（现价 ${mark.toFixed(2)} → ~${(mark * 1.09).toFixed(0)}）`);
      else if (conv.mult >= 2 && curRiskPct < targetRiskPct * 0.7) actions.push(`方向明确（×${conv.mult}），风险未用满 → 可加仓到 ${targetQty.toFixed(2)} 张`);
    }
    else if (stopProtects) {
      actions.push(`止损保护有效但偏重：最大亏损 ${curRiskPct.toFixed(1)}% 高于方向上限 ${targetRiskPct.toFixed(1)}%，可减到 ${targetQty.toFixed(2)} 张（卖出 ${sellQty.toFixed(2)} 张）或接受该风险持有`);
    }
    else if (over) {
      actions.push(`方向确信度支持 ≤${targetRiskPct.toFixed(1)}% 权益风险 → 减到 ${targetQty.toFixed(2)} 张（卖出 ${sellQty.toFixed(2)} 张）`);
      if (sellQty > 0.5) actions.push(`或收紧止损到 ${entry - (equity * targetRiskPct / 100 / qty)} 附近保持张数`);
    } else if (conv.mult >= 2 && curRiskPct < targetRiskPct * 0.7) {
      actions.push(`方向明确（×${conv.mult}），风险预算未用满 → 可加仓到 ${targetQty.toFixed(2)} 张（加 ${Math.max(0, targetQty - qty).toFixed(2)} 张）`);
    } else {
      actions.push('持有，按计划执行');
    }
    if (!sl) actions.push('立即挂止损');

    lines.push(`${level} ${p.instId} · ${side} · ${qty} 张`);
    lines.push(`  结论：${verdict}`);
    lines.push(`  💹 开仓 ${entry.toFixed(2)} → 当前 ${mark.toFixed(2)}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）`);
    lines.push(`  🛡️ 硬止损 ${sl ? sl.toFixed(2) : '未设置'}${tp ? ` · 止盈 ${tp.toFixed(2)}` : ' · 止盈未设置'}`);
    if (trailing) {
      lines.push(`  🔄 动态止损 生效中 · 激活 ${Number(trailing.activePx || 0).toFixed(2)} · 回撤 ${(Number(trailing.callbackRatio || 0) * 100).toFixed(2)}% · ${trailing.sz || qty} 张`);
    } else {
      lines.push('  🔄 动态止损 未设置/未读取到');
    }
    lines.push(`  ⚠️ 清算 ${liq ? liq.toFixed(2) : '--'} · 距清算 ${distLiq?.toFixed(2) || '--'}%`);
    for (const r of reasons) lines.push(`  · ${r}`);
    lines.push(`  📌 建议：${actions.join('；')}`);
    lines.push('  ────────────────');
  }
}

const todayPnl = Number(risk?.todayPnl || 0);
const realized = Number(risk?.todayRealized || 0);
const fees = Number(risk?.todayFees || 0);
lines.push(`💰 权益 ${equity.toFixed(2)} · 可用 ${Number(risk?.available || 0).toFixed(2)}`);
lines.push(`  今日 ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)} = 已实现 ${realized.toFixed(2)} + 手续费 ${fees.toFixed(2)} + 未实现 ${Number(risk?.todayUnrealized || 0).toFixed(2)}`);
if (fees < 0 && Math.abs(fees) > 15) lines.push(`  ⚠️ 手续费 -${Math.abs(fees).toFixed(2)} 占已实现利润 ${(Math.abs(fees) / Math.max(Math.abs(realized), 0.01) * 100).toFixed(0)}%，换手太频`);
console.log(lines.join('\n'));
