#!/usr/bin/env python3
"""动量策略深挖: 参数邻域 + 分年度 + 止损规则 + 组合验证
目标: 确认 20日/10% 不是参数峰值; 找到稳健参数区; 熊市表现
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

def momentum(df, lb=20, hold=5, thresh=0.10, stop=0.0):
    """动量: lb日收益>thresh做多, 持有hold天; stop>0则持仓期内止损"""
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
            # 止损检查
            if stop > 0 and (closes.iloc[i] - entry) / entry <= -stop:
                r = -stop - FEE
                eq *= (1 + r); trades += 1; wins += 0
                pos = 0
                continue
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    if pos == 1:
        r = (closes.iloc[-1] - entry) / entry - FEE
        eq *= (1 + r); trades += 1; wins += (r > 0)
    return eq, trades, wins / max(1, trades)

# 1. 参数邻域: lb × hold × thresh, 每参数算 11 标的验证期平均
print('=== 参数邻域 (验证期平均终值, 100起) ===')
print('lb/hold/thresh | 训练平均 | 验证平均 | 验证>100标的数')
results = []
for lb, hold, thresh in itertools.product([10, 15, 20, 30, 45], [3, 5, 8], [0.05, 0.10, 0.15, 0.20]):
    te_eqs, tr_eqs, n_pos = [], [], 0
    for sym in SYMS:
        df = load(sym)
        split = int(len(df) * 0.7)
        e1, _, _ = momentum(df.iloc[:split], lb, hold, thresh)
        e2, _, _ = momentum(df.iloc[split:], lb, hold, thresh)
        tr_eqs.append(e1); te_eqs.append(e2)
        if e2 > 100: n_pos += 1
    results.append((np.mean(te_eqs), np.mean(tr_eqs), n_pos, lb, hold, thresh))
results.sort(reverse=True)
for te, tr, n, lb, hold, th in results[:10]:
    print(f'{lb:>2}/{hold}/{th:.2f} | {tr:6.0f} | {te:6.0f} | {n}/11')

# 2. 最佳参数: 分年度 + 熊市验证
best = results[0]
lb, hold, th = best[3], best[4], best[5]
print(f'\n=== 最佳参数 (lb={lb}, hold={hold}, thresh={th}) 分年度 ===')
for sym in SYMS:
    df = load(sym)
    eq, tr, wr = momentum(df, lb, hold, th)
    print(f'{sym:>8}: 全样本 {eq:6.0f} | {tr}笔 | 胜率{wr*100:.1f}%')

# 3. 熊市验证 (2022 全年)
print(f'\n=== 2022 熊市单独验证 (lb={lb}, hold={hold}, thresh={th}) ===')
for sym in SYMS:
    df = load(sym)
    bear = df[(df.index >= '2022-01-01') & (df.index < '2023-01-01')]
    if len(bear) > 100:
        eq, tr, wr = momentum(bear, lb, hold, th)
        print(f'{sym:>8}: 2022 终值 {eq:5.0f} | {tr}笔 | 胜率{wr*100:.1f}%')

# 4. 止损影响
print(f'\n=== 止损规则影响 (lb={lb}, hold={hold}, thresh={th}) ===')
for stop in [0, 0.05, 0.10, 0.15]:
    eqs = []
    for sym in SYMS:
        df = load(sym)
        e, _, _ = momentum(df, lb, hold, th, stop)
        eqs.append(e)
    print(f'止损{stop*100:>3.0f}%: 11标的平均 {np.mean(eqs):6.0f}')
