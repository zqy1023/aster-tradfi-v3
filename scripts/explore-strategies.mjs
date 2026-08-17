// 策略方向验证: 横截面多空 vs 波动率突破 vs 均值回归
// 数据: Yahoo 日线 (18个月, 22标的)
// 方法: 每策略独立回测 + 70/30跨期验证, 含0.09%手续费
// 结论: 只有跨期验证通过的策略才可交易
import { readFile } from 'node:fs/promises';

// 读取全部标的日线
const files = ['AAOI', 'CBRS', 'CRCL', 'DRAM', 'SNDK', 'SNXX', 'KORU', 'SPCX', 'SOXL', 'TSM', 'NVDA', 'AMD', 'MU', 'META', 'AAPL', 'MSFT'];
const data = {};
for (const f of files) {
  try {
    const j = JSON.parse(await readFile(`/opt/aster-equity/data/import/cash_equity_daily/${f}-USDT-SWAP.meta.json`, 'utf8'));
    const p = JSON.parse(await readFile(`/opt/aster-equity/data/import/cash_equity_daily/${f}-USDT-SWAP.parquet`, 'utf8').catch(() => '{}'));
    // parquet是二进制, 直接读meta里的rows不够 → 用okx或跳过
    data[f] = { rows: j.rows || 0, start: j.start, end: j.end };
  } catch { /* skip */ }
}
console.log('标的meta:', JSON.stringify(data, null, 1).slice(0, 500));
