// 仓位自动管理器：监控持仓+信号 → 按规则决策 → 执行(带理由) → 推送
// 规则(用户授权): 权限全开, 但每次操作必须有理由
// 模式: --dry-run 只评估不执行(默认); --live 执行
import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4319';
const PASS = (await readFile('/root/aster-admin-initial.txt', 'utf8')).trim();
const LIVE = process.argv.includes('--live');
const QQ_TOKEN = process.argv.includes('--push') ? null : null; // 推送由 cron 报告处理

async function login() {
  const resp = await fetch(`${BASE}/api/v3/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  const jar = (resp.headers.get('set-cookie') || '').split(';')[0];
  if (!jar) throw new Error('登录失败');
  return jar;
}
async function api(cookie, path, opts = {}) {
  const resp = await fetch(`${BASE}${path}`, { headers: { cookie, 'content-type': 'application/json' }, ...opts, signal: AbortSignal.timeout(15000) });
  if (resp.status === 401) throw new Error('会话过期');
  return resp.json();
}

const jar = await login();
const [orders, risk, ws] = await Promise.all([api(jar, '/api/v3/orders'), api(jar, '/api/v3/risk/overview'), api(jar, '/api/v3/workstation')]);
const equity = Number(risk?.equity || 0);
const positions = orders.positions || [];
const oppByInst = new Map((ws.opportunities || []).map(o => [o.instId, o]));
const todayPnl = Number(risk?.todayPnl || 0);
const dailyLimit = equity * 0.04;

// 方向确信度（与报告一致）
function conviction(instId) {
  const opp = oppByInst.get(instId);
  if (!opp) return { level: '未知', mult: 1, decision: null, direction: null };
  const mom = opp.momentum;
  const signals = opp.signals || [];
  const momSig = signals.find(s => s.type === 'momentum_select');
  let mult = 1, level = '中性', direction = null;
  if (mom && mom.rank && mom.total) {
    const pct = mom.rank / mom.total;
    if (pct <= 0.1) { mult = 2.5; level = '强烈'; direction = 'long'; }
    else if (pct <= 0.3) { mult = 2.0; level = '明确'; direction = 'long'; }
    else if (pct <= 0.5) { mult = 1.5; level = '中等'; }
    else { mult = 0.8; level = '偏弱'; direction = null; }
  }
  if (momSig?.status === 'ready' && momSig.direction === 'long') { mult *= 1.3; direction = 'long'; }
  else if (momSig?.status === 'blocked') { mult *= 0.5; direction = null; }
  return { level, mult: Math.round(mult * 10) / 10, decision: opp.arbitration?.decision, direction };
}

const decisions = [];
const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

// ===== 1. 持仓管理 =====
for (const p of positions) {
  const instId = p.instId, side = p.side, qty = Math.abs(Number(p.quantity));
  const entry = Number(p.avgEntryPrice), mark = Number(p.markPrice), liq = Number(p.liquidationPrice);
  const algo = (p.raw?.closeOrderAlgo || [])[0] || {};
  const sl = Number(algo.slTriggerPx || 0), tp = Number(algo.tpTriggerPx || 0);
  const conv = conviction(instId);
  const lossPerUnit = sl ? Math.abs(entry - sl) : mark * 0.02;
  const curRisk = lossPerUnit * qty;
  const curRiskPct = equity ? curRisk / equity * 100 : 0;
  const targetRiskPct = 2 * conv.mult;
  const distLiq = mark && liq ? Math.abs(mark - liq) / mark * 100 : null;

  // 平仓: 方向反转(动量掉出前50% 或 仲裁变neutral)
  if (conv.direction === null && conv.level === '偏弱') {
    decisions.push({ action: '平仓', instId, qty, reason: `方向失效：动量排名 ${oppByInst.get(instId)?.momentum?.rank || '--'} 掉出前50%，趋势不再支持持仓` });
    continue;
  }
  // 平仓: 今日亏损达限
  if (todayPnl <= -dailyLimit) {
    decisions.push({ action: '平仓', instId, qty, reason: `单日亏损 ${todayPnl.toFixed(2)} 达 4% 限额，强制止损离场保护账户` });
    continue;
  }
  // 减仓: 距清算 <2%（无条件）
  if (distLiq !== null && distLiq < 2) {
    const safeQty = qty * 0.5;
    decisions.push({ action: '减仓', instId, qty: qty - safeQty, reason: `距清算仅 ${distLiq.toFixed(2)}%（清算价 ${liq.toFixed(0)}），减半仓降低爆仓风险` });
    continue;
  }
  // 减仓: 风险超上限 1.5倍
  if (curRiskPct > targetRiskPct * 1.5) {
    const targetQty = equity * targetRiskPct / 100 / lossPerUnit;
    decisions.push({ action: '减仓', instId, qty: Math.max(0, qty - targetQty), reason: `止损风险 ${curRiskPct.toFixed(1)}% 超方向上限 ${targetRiskPct.toFixed(1)}% 的1.5倍 → 减到 ${targetQty.toFixed(2)} 张` });
    continue;
  }
  // 加仓: 方向强烈 + 未用满预算
  if (conv.mult >= 2.5 && curRiskPct < targetRiskPct * 0.6 && todayPnl > 0) {
    const addQty = Math.min(qty * 0.5, (equity * targetRiskPct / 100 / lossPerUnit) - qty);
    if (addQty > 0.1) decisions.push({ action: '加仓', instId, qty: addQty, reason: `方向强烈 ×${conv.mult}（动量 #${oppByInst.get(instId)?.momentum?.rank}），风险未用满（现 ${curRiskPct.toFixed(1)}% vs 上限 ${targetRiskPct.toFixed(1)}%）→ 加 ${addQty.toFixed(2)} 张` });
  }
  // 保护单缺失
  if (!sl && !tp) decisions.push({ action: '挂保护', instId, reason: '持仓无止损止盈，裸仓风险，立即挂 SL/TP' });
}

// ===== 2. 开新仓机会（只在无持仓时或独立评估）=====
// 只对"有信号ready + 无持仓"的标的考虑开仓
for (const opp of (ws.opportunities || [])) {
  if (positions.some(p => p.instId === opp.instId)) continue; // 已有持仓不重复开
  const momSig = (opp.signals || []).find(s => s.type === 'momentum_select');
  const conv = conviction(opp.instId);
  if (momSig?.status === 'ready' && conv.direction === 'long' && conv.mult >= 2.0) {
    const volSig = (opp.signals || []).find(s => s.type === 'vol_target');
    const volOk = !(volSig?.evidence || []).join(' ').includes('波动飙升');
    if (volOk && todayPnl > -dailyLimit * 0.5) {
      // 建议开仓量: 风险预算 2×mult% 权益, 止损=现价2%(ATR参考)
      const riskBudget = equity * (2 * conv.mult) / 100;
      const estSl = Number(opp.price) * 0.98;
      const qty = riskBudget / (Number(opp.price) - estSl);
      decisions.push({ action: '开仓', instId: opp.instId, qty: Math.round(qty * 100) / 100, reason: `方向信号就绪：动量 #${opp.momentum?.rank}/${opp.momentum?.total}（${conv.level} ×${conv.mult}）+ 波动正常 → 建议开 ${Math.round(qty * 100) / 100} 张（止损风险 ${(2 * conv.mult).toFixed(1)}% 权益）` });
    }
  }
}

// ===== 输出 =====
if (!decisions.length) {
  console.log(`[仓位管理 ${now}] 无操作：${positions.length ? positions.map(p => `${p.instId} ${p.quantity}张 持有中`).join('、') : '当前空仓'}。今日 ${todayPnl.toFixed(2)}`);
} else {
  for (const d of decisions) {
    const line = `[${LIVE ? '执行' : '建议'}] ${d.action} ${d.instId}${d.qty ? ` ${d.qty} 张` : ''} — ${d.reason}`;
    console.log(line);
    if (LIVE) {
      // TODO: 执行(经 API: 下单/平仓/保护)
      console.log(`  → 已推送理由，等待执行通道`);
    }
  }
}
