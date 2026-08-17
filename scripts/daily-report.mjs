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
const fills = (orders.fills || []).filter((f) => f.sourceTs?.startsWith(new Date().toISOString().slice(0, 10)));

const lines = [];
lines.push(`📊 实盘日报 · ${new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`);
lines.push('━━━━━━━━━━━━━━━━');

// 今日操作
lines.push(`💰 权益 ${equity.toFixed(2)} · 今日盈亏 ${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}`);
lines.push(`📈 今日成交 ${fills.length} 笔`);

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
  lines.push('  持有中: 按 15%止损/80%止盈/10天持仓 管理');
} else {
  lines.push('  空仓等待信号');
}

console.log(lines.join('\n'));
