// 短周期动量策略回测：4H 周期 + 10-20日动量 + 手续费 + 杠杆约束
// 验证: OKX 4H 真实数据上, 短周期动量是否有正期望
// 用法: node scripts/backtest-short-momentum.mjs
import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4319';
const PASS = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();

async function login() {
  const r = await fetch(BASE + '/api/v3/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function get(cookie, path) {
  const r = await fetch(BASE + path, { headers: { cookie } });
  return r.json();
}

const cookie = await login();
// 从系统拉 4H K线（标的池：机会页 Top 标的）
const ws = await get(cookie, '/api/v3/workstation');
const instIds = (ws.opportunities || []).map((o) => o.instId).slice(0, 5);
if (!instIds.length) { console.log('无标的'); process.exit(1); }

const feeRate = 0.0005;  // taker
const slippage = 0.0004; // 滑点
const lever = 10;        // 短周期杠杆
const momWin = 10;       // 动量窗口(根, 10根4H=~1.7天)
const holdWin = 8;       // 持有窗口(根, 8根4H=~1.3天)

let allTrades = [];
for (const instId of instIds) {
  const m = await get(cookie, `/api/v3/markets/${encodeURIComponent(instId)}?bar=4H`);
  const cs = (m.candles || []).filter((c) => c.confirm !== false).map((c) => ({ t: Number(c.ts), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) }));
  if (cs.length < momWin + holdWin + 2) continue;
  // 动量策略: 过去 momWin 根涨幅前20% → 做多, 持有 holdWin 根
  for (let i = momWin; i < cs.length - holdWin; i++) {
    const mom = (cs[i].c - cs[i - momWin].c) / cs[i - momWin].c;
    if (mom <= 0.01) continue; // 动量过滤: 近10根涨幅>1%
    const entry = cs[i].c;
    const exit = cs[i + holdWin].c;
    const ret = (exit - entry) / entry;
    const fee = feeRate + slippage; // 单边成本
    const net = ret * lever - fee * 2 * lever; // 杠杆放大 - 双边成本
    allTrades.push({ instId, t: cs[i].t, entry, exit, mom: mom * 100, ret: ret * 100, net });
  }
}

if (!allTrades.length) { console.log('无交易'); process.exit(1); }
const wins = allTrades.filter((t) => t.net > 0);
const grossPnl = allTrades.reduce((s, t) => s + t.net, 0);
const pf = allTrades.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0) / Math.abs(allTrades.filter((t) => t.net < 0).reduce((s, t) => s + t.net, 0)) || 0;
console.log(`=== 短周期动量回测 (4H · ${instIds.length} 标的 · ${allTrades.length} 笔) ===`);
console.log(`动量窗口: ${momWin}根(≈${(momWin * 4 / 24).toFixed(1)}天) · 持有: ${holdWin}根(≈${(holdWin * 4 / 24).toFixed(1)}天) · 杠杆 ${lever}x`);
console.log(`胜率: ${(wins.length / allTrades.length * 100).toFixed(1)}%`);
console.log(`累计收益(净): ${grossPnl.toFixed(2)}% (含成本)`);
console.log(`Profit Factor: ${pf.toFixed(2)}`);
console.log(`平均单笔: ${(grossPnl / allTrades.length).toFixed(2)}%`);
console.log(`最大连亏: `);
let maxDD = 0, cur = 0;
for (const t of allTrades) { cur = t.net > 0 ? 0 : cur + t.net; maxDD = Math.min(maxDD, cur); }
console.log(`  ${maxDD.toFixed(2)}%`);
console.log(`分标的:`);
const byInst = {};
for (const t of allTrades) { byInst[t.instId] = byInst[t.instId] || []; byInst[t.instId].push(t); }
for (const [k, v] of Object.entries(byInst)) {
  const w = v.filter((t) => t.net > 0).length;
  console.log(`  ${k}: ${v.length}笔 胜率${(w / v.length * 100).toFixed(0)}% 净${v.reduce((s, t) => s + t.net, 0).toFixed(2)}%`);
}
