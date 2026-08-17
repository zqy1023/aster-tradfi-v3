// 持仓分析报告生成器：登录 → 拉 orders/risk/positions/diagnosis → 输出中文报告
// 供 cron 每 5 分钟推送到 QQ
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
  if (resp.status === 401) { throw new Error('会话过期'); }
  return resp.json();
}

const jar = await login();
const [orders, risk] = await Promise.all([api(jar, '/api/v3/orders'), api(jar, '/api/v3/risk/overview')]);

const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const positions = orders.positions || [];
const diag = orders.diagnosis || {};
const analysis = orders.analysis || {};
const acts = analysis.actions || {};

const lines = [];
lines.push(`📊 持仓分析报告 · ${now}`);
lines.push('━━━━━━━━━━━━━━━━');

// 持仓
if (positions.length) {
  for (const p of positions) {
    const side = p.side === 'long' ? '多' : '空';
    const pnl = Number(p.unrealizedPnl || 0);
    lines.push(`📈 ${p.instId} ${side} ${Math.abs(p.quantity)}张
  开仓 ${Number(p.avgEntryPrice).toFixed(2)} → 标记 ${Number(p.markPrice).toFixed(2)}
  未实现盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
  }
} else {
  lines.push('📭 当前无持仓');
}
lines.push('━━━━━━━━━━━━━━━━');

// 账户
if (risk) {
  const realized = Number(risk.todayRealized || 0), fees = Number(risk.todayFees || 0), unreal = Number(risk.todayUnrealized || 0);
  const pnl = Number(risk.todayPnl || 0);
  lines.push(`💰 权益 ${Number(risk.equity).toFixed(2)} · 可用 ${Number(risk.available).toFixed(2)}
  今日盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} = 已实现 ${realized.toFixed(2)} + 手续费 ${fees.toFixed(2)} + 未实现 ${unreal.toFixed(2)}
  敞口 ${Number(risk.grossExposure).toFixed(2)} 倍权益`);
}

// 诊断
if (diag.findings?.length) {
  const warns = diag.findings.filter((f) => f.level === 'warn' || f.level === 'bad');
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push(`🔍 诊断：${diag.summary || '—'}`);
  for (const f of warns.slice(0, 3)) {
    lines.push(`  ${f.level === 'bad' ? '🔴' : '🟡'} ${f.title}：${f.detail}`);
  }
  if (warns.length > 3) lines.push(`  ...还有 ${warns.length - 3} 项`);
}

console.log(lines.join('\n'));
