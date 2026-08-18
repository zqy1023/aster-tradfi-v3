// 每日日报: 美股收盘后推送 (16:30 北京时间 = 美东 16:30 收盘后)
// 内容: 今日操作/持仓/盈亏/信号/明日计划
// 用法: node scripts/daily-report.mjs
import { readFile } from 'node:fs/promises';

const B = 'http://127.0.0.1:4319';
const pass = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();
const r = await fetch(B + '/api/v3/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pass }) });
const cookie = (r.headers.get('set-cookie') || '').split(';')[0];

async function api(path) {
  const res = await fetch(B + path, { headers: { cookie } });
  return res.json();
}

const [orders, ws, review] = await Promise.all([api('/api/v3/orders'), api('/api/v3/workstation'), api('/api/v3/reviews/daily')]);

const positions = orders.positions || [];
const equity = orders.risk?.equity || 0;
const todayPnl = orders.risk?.todayPnl ?? 0;
const accountPending = orders.risk?.source === 'waiting-account-ws' || orders.risk?.source === 'pending';
// 北京时间"今日"（用户要求: 所有展示用UTC+8; UTC凌晨会把昨天算成今天）
const bjToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const fills = (orders.fills || []).filter((f) => f.sourceTs?.startsWith(bjToday));

const lines = [];
lines.push(`📊 实盘日报 · ${new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`);
lines.push('━━━━━━━━━━━━━━━━');

// 今日操作
if (accountPending) {
  lines.push(`⚠️ 账户待连接（OKX 凭据未配置或已失效），权益数据暂不可用`);
  lines.push(`📈 今日成交 ${fills.length} 笔`);
} else {
  lines.push(`💰 权益 ${equity.toFixed(2)} · 今日盈亏 ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}`);
  lines.push(`📈 今日成交 ${fills.length} 笔`);
}

// 持仓
if (positions.length) {
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push('📦 当前持仓:');
  for (const p of positions) {
    const notional = Math.abs(Number(p.quantity)) * Number(p.markPrice || 0);
    lines.push(`  ${p.instId} ${p.side === 'long' ? '多' : '空'} ${p.quantity}张 开仓${Number(p.avgEntryPrice).toFixed(2)} 现价${Number(p.markPrice || 0).toFixed(2)} 浮盈${Number(p.unrealizedPnl || 0).toFixed(2)} 名义${notional.toFixed(0)}U`);
  }
} else {
  lines.push('📦 持仓: 无');
}

// ===== 今日交易复盘（用户要求每日复盘）=====
lines.push('━━━━━━━━━━━━━━━━');
lines.push('🔍 今日复盘:');
if (fills.length) {
  // 按标的分组统计
  const byInst = {};
  for (const f of fills) {
    const inst = f.instId;
    byInst[inst] = byInst[inst] || { buys: 0, sells: 0, fee: 0, size: 0 };
    if (f.side === 'buy') byInst[inst].buys += Math.abs(Number(f.size) || 0);
    else byInst[inst].sells += Math.abs(Number(f.size) || 0);
    byInst[inst].fee += Math.abs(Number(f.fee) || 0);
    byInst[inst].size += Math.abs(Number(f.size) || 0);
  }
  for (const [inst, v] of Object.entries(byInst)) {
    const net = v.sells - v.buys; // 净平仓方向
    let action = '持有/调仓';
    if (v.buys > 0 && v.sells === 0) action = '加仓/开仓';
    else if (v.sells > 0 && v.buys === 0) action = '减仓/平仓';
    else if (v.buys > 0 && v.sells > 0) action = '开平都有';
    lines.push(`  ${inst}: ${action} 买${v.buys.toFixed(1)}/卖${v.sells.toFixed(1)} 手续费${v.fee.toFixed(2)}U`);
  }
  // 复盘结论
  const totalFee = Object.values(byInst).reduce((s, v) => s + v.fee, 0);
  if (totalFee > 5) lines.push(`  ⚠️ 今日手续费 ${totalFee.toFixed(2)}U 偏高，检查是否频繁调仓`);
  else if (totalFee > 0) lines.push(`  ✅ 今日手续费 ${totalFee.toFixed(2)}U 可控`);
} else {
  lines.push('  今日无成交，持仓持有中');
}
// 持仓复盘: 每仓逻辑是否符合策略
for (const p of positions) {
  const pnl = Number(p.unrealizedPnl || 0);
  const pnlPct = p.avgEntryPrice ? pnl / (Math.abs(Number(p.quantity)) * Number(p.avgEntryPrice)) * 100 : 0;
  if (pnl > 0) lines.push(`  ✅ ${p.instId} 浮盈 ${pnl.toFixed(2)}U (${pnlPct.toFixed(1)}%)，按策略持有`);
  else if (pnl < 0) lines.push(`  ⚠️ ${p.instId} 浮亏 ${pnl.toFixed(2)}U (${pnlPct.toFixed(1)}%)，止损${Number(p.avgEntryPrice) * 0.85 > Number(p.markPrice) ? '临近' : '有空间'}，继续按策略`);
}

// 信号状态
lines.push('━━━━━━━━━━━━━━━━');
lines.push('📡 策略信号:');
const opps = (ws.opportunities || []).slice(0, 5);
for (const o of opps) {
  const rm = (o.signals || []).find((s) => s.type === 'roll_momentum');
  if (rm) {
    lines.push(`  ${o.instId}: 滚仓v5 ${rm.status} ${rm.score}分 (${(rm.scoreBasis || [])[0] || ''})`);
  }
}

// 明日计划
lines.push('━━━━━━━━━━━━━━━━');
const rmReady = opps.filter((o) => (o.signals || []).find((s) => s.type === 'roll_momentum' && s.status === 'ready'));
lines.push('📌 明日计划:');
if (positions.length === 0 && rmReady.length) {
  lines.push(`  ${rmReady[0].instId} 等动量#1/2 信号 ready → 按滚仓v5开仓`);
} else if (positions.length) {
  lines.push('  持有中: 按 15%止损/40%止盈/10天持仓 管理');
} else {
  lines.push('  空仓等待信号');
}

console.log(lines.join('\n'));
