// 持仓分析报告 v4：结论 + 明确数学(减仓到多少张/卖出多少张)
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
const [orders, risk] = await Promise.all([api(jar, '/api/v3/orders'), api(jar, '/api/v3/risk/overview')]);
const positions = orders.positions || [];
const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const equity = Number(risk?.equity || 0);
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
    const algo = (raw.closeOrderAlgo || [])[0] || {};
    const sl = Number(algo.slTriggerPx || 0), tp = Number(algo.tpTriggerPx || 0);
    const holdMs = Date.now() - (Date.parse(p.sourceTs || p.recvTs) || Date.now());
    const holdMin = Math.round(holdMs / 60000);
    const pct = entry ? (mark - entry) / entry * 100 * (side === '多' ? 1 : -1) : 0;

    // ===== 核心数学 =====
    const lossPerUnit = Math.abs(entry - sl);          // 每张止损亏损
    const curRisk = lossPerUnit * qty;                 // 当前止损总亏损
    const curRiskPct = equity ? curRisk / equity * 100 : 0;
    const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;
    const distSl = mark && sl ? Math.abs(mark - sl) / mark * 100 : null;
    // 目标: 单笔止损亏损 ≤2% 权益 (标准风控) 与 ≤5% (宽松)
    const qty2 = (equity * 0.02) / lossPerUnit;        // 2%目标可持仓
    const qty5 = (equity * 0.05) / lossPerUnit;        // 5%目标可持仓
    const sell2 = Math.max(0, qty - qty2);             // 2%目标需卖出
    const sell5 = Math.max(0, qty - qty5);             // 5%目标需卖出
    // 清算距离目标: 距清算 ≥10% → 杠杆 = 1/0.10 = 10x → 名义 = 权益×10
    const liqSafeQty = equity * 10 / mark;             // 10x杠杆可持仓
    const sellLiq = Math.max(0, qty - liqSafeQty);

    // ===== 风险等级 =====
    let level, verdict, reasons = [], actions = [];
    if (liq && distLiq !== null && distLiq < 2) { level = '🔴 高危'; verdict = `距清算仅 ${distLiq.toFixed(2)}%，随时可能爆仓`; }
    else if (liq && distLiq !== null && distLiq < 5) { level = '🟠 偏高'; verdict = '杠杆过高，清算距离偏近'; }
    else { level = '🟢 正常'; verdict = '清算距离安全'; }

    // 风险点
    if (distLiq !== null) reasons.push(`距清算 ${distLiq.toFixed(2)}%（清算价 ${liq.toFixed(0)}）`);
    if (sl) reasons.push(`止损 ${sl.toFixed(2)}（距现价 ${distSl?.toFixed(2)}%）`);
    else { reasons.push('未挂止损，裸仓'); actions.push('立即挂止损'); }
    reasons.push(`若止损触发亏 ${curRiskPct.toFixed(1)}% 权益（${curRisk.toFixed(2)} USDT）`);
    reasons.push(`浮${upl >= 0 ? '盈' : '亏'} ${upl >= 0 ? '+' : ''}${upl.toFixed(2)}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）· 开仓 ${holdMin} 分钟`);
    if (tp) { const rr = Math.abs(tp - entry) / Math.max(lossPerUnit, 0.0001); if (rr > 5) reasons.push(`止盈 ${tp.toFixed(0)} 盈亏比 ${rr.toFixed(1)}:1 目标过远`); }

    // ===== 明确减仓数学 =====
    if (curRiskPct > 5) {
      actions.push(`减仓到 ${qty5.toFixed(2)} 张（卖出 ${sell5.toFixed(2)} 张）→ 止损亏损降到 ${(equity * 0.05).toFixed(2)} USDT = 5% 权益`);
      if (curRiskPct > 10) actions.push(`严格风控：减到 ${qty2.toFixed(2)} 张（卖出 ${sell2.toFixed(2)} 张）→ 止损亏损 2% 权益`);
    }
    if (distLiq !== null && distLiq < 5) {
      actions.push(`杠杆 ${lev}x 降为 10x：卖出 ${sellLiq.toFixed(2)} 张，留 ${liqSafeQty.toFixed(2)} 张 → 距清算拉远到 ~10%`);
    }
    if (!actions.length) actions.push('持有，按计划执行');

    lines.push(`${level} ${p.instId} · ${side} · ${qty} 张`);
    lines.push(`  结论：${verdict}`);
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
