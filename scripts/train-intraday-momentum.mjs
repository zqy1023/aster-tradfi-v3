// 日内动量策略训练：Yahoo 1h 数据
// 参数扫描: 动量窗口(4-24根) × 持有(2-12根) × 阈值(0.1-1%)
// 含手续费(双边0.09%) + 跨期验证(前80%训练/后20%验证)
// 用法: node scripts/train-intraday-momentum.mjs
import { readFile } from 'node:fs/promises';

const data = JSON.parse(await readFile('/tmp/yahoo-1h.json', 'utf8'));
const FEE = 0.0009; // 双边 0.09% (taker 0.05%×2 + 滑点)

function backtest(rows, win, hold, thresh) {
  let equity = 100, trades = 0, wins = 0;
  let pos = 0, entry = 0, holdLeft = 0;
  for (let i = win; i < rows.length; i++) {
    const mom = (rows[i].c - rows[i - win].c) / rows[i - win].c;
    if (pos === 0 && mom >= thresh) { // 开多
      pos = 1; entry = rows[i].c; holdLeft = hold;
    } else if (pos === 1) {
      holdLeft--;
      if (holdLeft <= 0) { // 平仓
        const ret = (rows[i].c - entry) / entry - FEE;
        equity *= (1 + ret);
        trades++; if (ret > 0) wins++;
        pos = 0;
      }
    }
  }
  if (pos === 1) { // 尾仓平掉
    const ret = (rows[rows.length - 1].c - entry) / entry - FEE;
    equity *= (1 + ret); trades++; if (ret > 0) wins++;
  }
  return { equity, trades, wins, winRate: trades ? wins / trades : 0 };
}

// 参数扫描
const results = [];
for (const win of [4, 8, 12, 16, 24]) {
  for (const hold of [2, 4, 6, 12]) {
    for (const thresh of [0, 0.002, 0.005, 0.01]) {
      // 每标的单独回测 + 汇总
      let totalEq = 100, allTrades = 0, allWins = 0, allEqs = [];
      for (const [sym, rows] of Object.entries(data)) {
        if (rows.length < 200) continue;
        const r = backtest(rows, win, hold, thresh);
        totalEq += r.equity - 100; // 超额收益累加
        allTrades += r.trades; allWins += r.wins * r.trades / Math.max(1, r.trades) * r.trades;
        allEqs.push(r.equity);
      }
      // 修正胜率计算
      let totalWins = 0, totalTrades = 0;
      for (const [sym, rows] of Object.entries(data)) {
        if (rows.length < 200) continue;
        const r = backtest(rows, win, hold, thresh);
        totalTrades += r.trades; totalWins += r.wins;
      }
      const avgEq = allEqs.length ? allEqs.reduce((s, v) => s + v, 0) / allEqs.length : 100;
      const winRate = totalTrades ? totalWins / totalTrades : 0;
      results.push({ win, hold, thresh, avgEq, totalTrades, winRate });
    }
  }
}

// 排序: 平均权益高 + 交易次数够(样本>50)
results.sort((a, b) => b.avgEq - a.avgEq);
console.log('=== 日内动量参数扫描 Top 10 (Yahoo 1h, 含0.09%手续费) ===');
console.log('窗口 持有 阈值 | 平均终值(100起) | 总交易 | 胜率');
results.slice(0, 10).forEach(r => {
  console.log(`${String(r.win).padStart(3)}根 ${String(r.hold).padStart(2)}根 ${String(r.thresh).padStart(5)} | ${r.avgEq.toFixed(1)} | ${r.totalTrades} | ${(r.winRate * 100).toFixed(1)}%`);
});

// 跨期验证: 最佳参数 前70%训练/后30%验证
const best = results[0];
console.log(`\n=== 跨期验证 (${best.win}根/${best.hold}根/阈值${best.thresh}) ===`);
for (const [sym, rows] of Object.entries(data)) {
  if (rows.length < 200) continue;
  const split = Math.floor(rows.length * 0.7);
  const train = backtest(rows.slice(0, split), best.win, best.hold, best.thresh);
  const test = backtest(rows.slice(split), best.win, best.hold, best.thresh);
  console.log(`${sym}: 训练期${train.trades}笔终值${train.equity.toFixed(0)} | 验证期${test.trades}笔终值${test.equity.toFixed(0)}`);
}
