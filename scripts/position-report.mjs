// 持仓分析报告 v3：分析(结论→风险→建议)，不是字段罗列
// 每笔持仓: 风险等级判断 + 关键风险点 + 明确动作建议
import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4319';
const PASS = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();

async function login() {
  const resp = await fetch(`${BASE}/api/v3/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  const raw = resp.headers.get('set-cookie') || '';
  const jar = raw.split(';')[0];
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
    const entry = Number(p.avgEntryPrice);
    const mark = Number(p.markPrice);
    const qty = Math.abs(Number(p.quantity));
    const upl = Number(p.unrealizedPnl || 0);
    const lev = Number(p.leverage || 1);
    const liq = Number(p.liquidationPrice);
    const notional = Number(p.notionalUsd || 0);
    const raw = p.raw || {};
    const algo = (raw.closeOrderAlgo || [])[0] || {};
    const sl = Number(algo.slTriggerPx || 0);
    const tp = Number(algo.tpTriggerPx || 0);
    const holdMs = Date.now() - (Date.parse(p.sourceTs || p.recvTs) || Date.now());
    const holdMin = Math.round(holdMs / 60000);
    const pct = entry ? (mark - entry) / entry * 100 * (side === '多' ? 1 : -1) : 0;
    // 距离分析
    const distSl = mark && sl ? Math.abs(mark - sl) / mark * 100 : null;      // 距止损 %
    const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;    // 距清算 %
    const marginUse = notional / lev;                                          // 保证金占用
    const marginPct = equity ? marginUse / equity * 100 : 0;                   // 保证金占权益 %
    const notionalMult = equity ? notional / equity : 0;                       // 名义/权益倍数
    const riskPerTrade = mark && sl ? Math.abs(mark - sl) * qty : 0;           // 若止损触发亏多少
    const riskPctEquity = equity ? riskPerTrade / equity * 100 : 0;            // 止损亏损占权益 %

    // ==== 分析结论 ====
    let verdict, level, reasons = [], actions = [];

    // 1. 爆仓风险（最高优先级）
    if (liq && distLiq !== null && distLiq < 2) {
      level = '🔴 高危'; verdict = '距清算不足 2%，随时可能爆仓';
      reasons.push(`价格反向 ${distLiq.toFixed(2)}% 即触发清算（清算价 ${liq.toFixed(0)}）`);
      actions.push('立即降低杠杆或减仓，把清算距离拉到 10% 以上');
    } else if (liq && distLiq !== null && distLiq < 5) {
      level = '🟠 偏高'; verdict = '杠杆过高，清算距离偏近';
      reasons.push(`距清算仅 ${distLiq.toFixed(2)}%（清算价 ${liq.toFixed(0)}），50x 杠杆下正常波动都可能触发`);
      actions.push('建议降低杠杆或部分减仓，避免被插针清算');
    } else {
      level = '🟢 正常'; verdict = '清算距离安全';
      reasons.push(`距清算 ${distLiq?.toFixed(2) || '--'}%`);
    }

    // 2. 止损保护
    if (sl) {
      reasons.push(`止损已挂 ${sl.toFixed(2)}（距现价 ${distSl?.toFixed(2)}%）`);
      if (distSl !== null && distSl < 1) { actions.push('止损距现价过近，容易被正常波动扫掉'); }
    } else {
      reasons.push('⚠️ 未挂止损，裸仓风险');
      actions.push('立即挂止损（建议 ATR 1.5-2 倍距离）');
    }

    // 3. 仓位集中度
    if (marginPct > 60) { reasons.push(`保证金占用 ${marginPct.toFixed(0)}% 权益，接近满仓`); actions.push('单笔仓位过重，任何反向波动都会重伤账户'); }
    else if (marginPct > 30) { reasons.push(`保证金占用 ${marginPct.toFixed(0)}% 权益`); }

    // 4. 浮盈浮亏 + 盈亏比
    if (upl > 0) {
      reasons.push(`当前浮盈 +${upl.toFixed(2)}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）`);
      if (tp) { const rr = Math.abs(tp - entry) / Math.max(Math.abs(entry - sl), 0.0001); if (rr > 5) reasons.push(`止盈目标 ${tp.toFixed(0)} 盈亏比 ${rr.toFixed(1)}:1，但目标过远兑现概率低`); }
    } else {
      reasons.push(`当前浮亏 ${upl.toFixed(2)}（${pct.toFixed(2)}%）`);
      actions.push('浮亏单：若跌破止损价 1710 必须离场，不要扛单');
    }

    // 5. 持仓时间
    if (holdMin < 60) reasons.push(`刚开仓 ${holdMin} 分钟`);

    // 6. 止损亏损占比
    if (riskPctEquity > 3) { reasons.push(`若止损触发将亏 ${riskPctEquity.toFixed(1)}% 权益`); actions.push('单笔风险超 3%，减仓到止损亏损 ≤2% 权益'); }

    // 输出
    lines.push(`${level} ${p.instId} · ${side} · ${qty} 张`);
    lines.push(`  结论：${verdict}`);
    for (const r of reasons) lines.push(`  · ${r}`);
    lines.push(`  📌 建议：${actions.length ? actions.join('；') : '持有，按计划执行'}`);
    lines.push('  ────────────────');
  }
}

// 账户级结论
const todayPnl = Number(risk?.todayPnl || 0);
const realized = Number(risk?.todayRealized || 0);
const fees = Number(risk?.todayFees || 0);
lines.push(`💰 权益 ${equity.toFixed(2)} · 可用 ${Number(risk?.available || 0).toFixed(2)}`);
lines.push(`  今日 ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)} = 已实现 ${realized.toFixed(2)} + 手续费 ${fees.toFixed(2)} + 未实现 ${Number(risk?.todayUnrealized || 0).toFixed(2)}`);
if (fees < 0 && Math.abs(fees) > 15) lines.push(`  ⚠️ 今日手续费 -${Math.abs(fees).toFixed(2)}，占了已实现利润的 ${(Math.abs(fees) / Math.max(Math.abs(realized), 0.01) * 100).toFixed(0)}%，换手太频`);

console.log(lines.join('\n'));
