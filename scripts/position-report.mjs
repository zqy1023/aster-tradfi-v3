// 持仓分析报告生成器 v2：只分析【当前持仓交易】本身，不扯历史成交统计
// 输入: 当前持仓(positions) + 风险(risk) + 该持仓的止损止盈(attachAlgoOrds)
// 输出: 每笔持仓的 方向/成本/现价/盈亏/杠杆/清算价/持仓时间/止损止盈/风险诊断
import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4319';
const PASS = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();

async function login() {
  const resp = await fetch(`${BASE}/api/v3/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  const raw = resp.headers.get('set-cookie') || '';
  const jar = raw.split(';')[0];
  if (!jar) throw new Error('登录失败：未获取到会话');
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
    const holdH = holdMs / 3600000;
    const pct = entry ? (mark - entry) / entry * 100 * (p.side === 'long' ? 1 : -1) : 0;
    const distLiq = mark ? Math.abs(mark - liq) / mark * 100 : 0;

    lines.push(`📈 ${p.instId} · ${side} · ${qty} 张`);
    lines.push(`  成本 ${entry.toFixed(2)} → 现价 ${mark.toFixed(2)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    lines.push(`  未实现盈亏 ${upl >= 0 ? '+' : ''}${upl.toFixed(2)} USDT · 杠杆 ${lev}x`);
    lines.push(`  持仓 ${holdH < 1 ? (holdH * 60).toFixed(0) + ' 分钟' : holdH.toFixed(1) + ' 小时'}`);
    lines.push(`  清算价 ${liq ? liq.toFixed(2) : '--'} · 距清算 ${distLiq.toFixed(2)}%`);
    if (sl) lines.push(`  止损 ${sl.toFixed(2)}${tp ? ` · 止盈 ${tp.toFixed(2)}` : ''}  (已挂 OKX)`);
    // 盈亏比
    if (sl && tp) {
      const riskPer = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      if (riskPer > 0) lines.push(`  盈亏比 ${(reward / riskPer).toFixed(2)}:1`);
    }
    // 方向诊断
    const above = p.side === 'long' ? mark > entry : mark < entry;
    lines.push(above ? '  ✅ 浮盈持仓，止损已保护' : '  ⚠️ 浮亏持仓，注意止损/清算距离');
    lines.push('  ────────────────');
  }
}

lines.push(`💰 权益 ${Number(risk?.equity || 0).toFixed(2)} · 可用 ${Number(risk?.available || 0).toFixed(2)}`);
const todayPnl = Number(risk?.todayPnl || 0);
lines.push(`  今日盈亏 ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)} = 已实现 ${Number(risk?.todayRealized || 0).toFixed(2)} + 手续费 ${Number(risk?.todayFees || 0).toFixed(2)} + 未实现 ${Number(risk?.todayUnrealized || 0).toFixed(2)}`);

console.log(lines.join('\n'));
