#!/usr/bin/env python3
"""波动率突破策略深挖: 参数扫描 + 分标的 + 跨期 + 杠杆适配
目标: 找到跨期验证稳定的参数, 评估实盘可行性(手续费/杠杆/持仓天数)
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np
import glob, os, itertools

FEE = 0.0009
files = sorted(glob.glob('/opt/aster-equity/data/import/cash_equity_daily/*.parquet'))
data = {}
for f in files:
    sym = os.path.basename(f).replace('-USDT-SWAP.parquet', '')
    try:
        df = pq.read_table(f).to_pandas()
        df.index = pd.to_datetime(df.index)
        df = df[~df.index.duplicated()].sort_index()
        if len(df) >= 150:
            data[sym] = df['close']
    except: pass
print(f'标的: {len(data)}')

def breakout(df, lookback=20, mult=1.5, hold=3):
    """波动率突破: 收盘突破 均线+mult×ATR → 持有hold天"""
    closes = df.dropna()
    if len(closes) < 60: return None, 0, 0
    tr = pd.concat([closes.diff(), closes - closes.rolling(2).max().shift(), closes.rolling(2).min().shift() - closes], axis=1).max(axis=1)
    atr = tr.rolling(lookback).mean()
    ma = closes.rolling(lookback).mean()
    eq, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lookback + 5, len(closes)):
        if pos == 0:
            upper = ma.iloc[i] + mult * atr.iloc[i]
            if closes.iloc[i] > upper:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    return eq, trades, wins / max(1, trades)

# 参数扫描 + 跨期验证
print('\n=== 参数扫描(全样本终值 | 训练期 | 验证期 | 笔数) ===')
print('lookback mult hold | 全样本 | 训练 | 验证 | 笔数')
results = []
for lb, mult, hold in itertools.product([10, 20, 30], [1.0, 1.5, 2.0], [2, 3, 5]):
    eqs, trs = [], 0
    for s, d in data.items():
        eq, t, _ = breakout(d, lb, mult, hold)
        if eq: eqs.append(eq); trs += t
    if not eqs: continue
    avg = np.mean(eqs)
    # 跨期
    eq_tr, eq_te, tr_tr, tr_te = [], [], 0, 0
    for s, d in data.items():
        split = int(len(d) * 0.7)
        e1, t1, _ = breakout(d.iloc[:split], lb, mult, hold)
        e2, t2, _ = breakout(d.iloc[split:], lb, mult, hold)
        if e1: eq_tr.append(e1); tr_tr += t1
        if e2: eq_te.append(e2); tr_te += t2
    results.append((avg, np.mean(eq_tr) if eq_tr else 0, np.mean(eq_te) if eq_te else 0, tr_tr + tr_te, lb, mult, hold))

results.sort(key=lambda r: r[2], reverse=True)  # 按验证期排序
for avg, tr, te, n, lb, mult, hold in results[:10]:
    print(f'{lb:>3} {mult:>4} {hold:>3} | {avg:6.0f} | {tr:6.0f} | {te:6.0f} | {n}')

# 最佳参数分标的
best = results[0]
lb, mult, hold = best[4], best[5], best[6]
print(f'\n=== 最佳参数 (lookback={lb}, mult={mult}, hold={hold}) 分标的 ===')
print('标的 | 全样本 | 验证期 | 笔数 | 胜率')
for s, d in data.items():
    split = int(len(d) * 0.7)
    e1, t1, w1 = breakout(d.iloc[:split], lb, mult, hold)
    e2, t2, w2 = breakout(d.iloc[split:], lb, mult, hold)
    e0, t0, w0 = breakout(d, lb, mult, hold)
    print(f'{s:>6} | {e0:6.0f} | {e2 or 0:6.0f} | {t1 + t2:4d} | {(w0 or 0)*100:4.1f}%')
