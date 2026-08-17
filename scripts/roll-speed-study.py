#!/usr/bin/env python3
"""滚仓速度研究: 动量策略的持仓周期压缩 vs 收益/手续费
目标: 找"最快滚仓"且跨期验证仍正的参数
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np
import itertools

FEE = 0.0009
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

def momentum(df, lb=20, hold=8, thresh=0.20, stop=0.05):
    closes = df['close'].dropna()
    eq, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lb + 5, len(closes)):
        if pos == 0:
            mom = (closes.iloc[i] - closes.iloc[i - lb]) / closes.iloc[i - lb]
            if mom >= thresh:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if stop > 0 and (closes.iloc[i] - entry) / entry <= -stop:
                r = -stop - FEE
                eq *= (1 + r); trades += 1; pos = 0
                continue
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    return eq, trades, wins / max(1, trades)

print('=== 滚仓速度扫描 (验证期, 11标的平均) ===')
print('lb/hold/thresh/stop | 训练均 | 验证均 | 年化交易次数 | 验证>100')
# 快滚仓 = 短lb + 短hold + 低阈值(频繁进出)
results = []
for lb, hold, thresh, stop in itertools.product(
    [5, 10, 15, 20],        # 动量窗口(短=响应快)
    [1, 2, 3, 5],           # 持有天数(短=滚得快)
    [0.03, 0.05, 0.10, 0.20], # 阈值(低=更多信号)
    [0.03, 0.05]):          # 止损
    te_eqs, tr_eqs, n_pos, total_tr = [], [], 0, 0
    for sym in SYMS:
        df = load(sym)
        split = int(len(df) * 0.7)
        e1, t1, _ = momentum(df.iloc[:split], lb, hold, thresh, stop)
        e2, t2, _ = momentum(df.iloc[split:], lb, hold, thresh, stop)
        tr_eqs.append(e1); te_eqs.append(e2)
        total_tr += t1 + t2
        if e2 > 100: n_pos += 1
    # 年化交易次数: 总交易 / 10年
    per_year = total_tr / 10
    results.append((np.mean(te_eqs), np.mean(tr_eqs), n_pos, per_year, lb, hold, thresh, stop))

# 按验证收益排序
results.sort(reverse=True)
print('--- Top 12 (按验证收益) ---')
for te, tr, n, py, lb, h, th, st in results[:12]:
    print(f'{lb:>2}d/{h}d/{th:.2f}/stop{st:.2f} | {tr:6.0f} | {te:6.0f} | {py:5.1f}次/年 | {n}/11')

# 按滚仓速度排序(年化交易多 + 验证正)
print('\n--- 最快滚仓且验证正 (年化交易≥20, 验证>100) ---')
fast = [r for r in results if r[2] >= 8 and r[3] >= 20]
fast.sort(key=lambda r: r[3], reverse=True)
for te, tr, n, py, lb, h, th, st in fast[:8]:
    print(f'{lb:>2}d/{h}d/{th:.2f}/stop{st:.2f} | 验证{te:6.0f} | {py:5.1f}次/年 | {n}/11')

if not fast:
    print('无(快滚仓参数全崩或样本不足)')
