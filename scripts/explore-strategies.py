#!/usr/bin/env python3
"""策略方向验证: 横截面多空 vs 波动率突破 vs 均值回归
数据: Yahoo 日线(18个月, 22标的, /opt/aster-equity/data/import/cash_equity_daily/*.parquet)
方法: 每策略独立回测 + 70/30跨期验证 + 双边0.09%手续费
规则: 只有跨期验证仍为正的策略才可交易
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np
import glob, os

FEE = 0.0009  # 双边手续费+滑点

# 加载全部标的日线
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
    except Exception as e:
        print(f'{sym}: 跳过 {e}')
print(f'可用标的: {len(data)} 个')

def cross_sectional(df_dict, lookback=20, top_pct=0.3, hold=5):
    """横截面多空: 每hold天按过去lookback收益排名, 买top_pct卖bottom_pct"""
    dates = sorted(set().union(*[set(d.index) for d in df_dict.values()]))
    closes = pd.DataFrame({s: d for s, d in df_dict.items()}).ffill()
    ret = closes.pct_change()
    equity, trades, wins = 100, 0, 0
    pos = {}
    last_rank_day = -1
    for i in range(lookback, len(closes)):
        date = closes.index[i]
        # 每hold天调仓
        if i - last_rank_day >= hold:
            mom = closes.iloc[i - lookback:i].pct_change().sum()
            valid = mom.dropna()
            if len(valid) >= 5:
                n = max(1, int(len(valid) * top_pct))
                top = valid.nlargest(n).index
                bottom = valid.nsmallest(n).index
                pos = {s: (1 if s in top else -1 if s in bottom else 0) for s in valid.index}
                last_rank_day = i
        # 组合收益
        day_ret = ret.iloc[i]
        if pos:
            pnl = sum(pos.get(s, 0) * (day_ret.get(s, 0) - FEE / len(pos)) for s in pos if pos.get(s) != 0)
            equity *= (1 + pnl / max(1, sum(1 for v in pos.values() if v != 0)))
            trades += 1
            if pnl > 0: wins += 1
    return equity, trades, wins / max(1, trades)

def vol_breakout(df, lookback=20, mult=1.5, hold=3):
    """波动率突破: ATR通道突破进, 持有hold天"""
    closes = df.dropna()
    if len(closes) < 60: return None, 0, 0
    tr = pd.concat([closes.diff(), closes - closes.rolling(2).max().shift(), closes.rolling(2).min().shift() - closes], axis=1).max(axis=1)
    atr = tr.rolling(lookback).mean()
    equity, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lookback + 5, len(closes)):
        if pos == 0:
            upper = closes.iloc[i - lookback:i].mean() + mult * atr.iloc[i - lookback:i].mean()
            if closes.iloc[i] > upper:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                equity *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    return equity, trades, wins / max(1, trades)

def mean_reversion(df, lookback=14, z_thresh=2.0, hold=3):
    """均值回归: RSI超卖/价格低于布林下轨反弹"""
    closes = df.dropna()
    if len(closes) < 60: return None, 0, 0
    sma = closes.rolling(lookback).mean()
    std = closes.rolling(lookback).std()
    equity, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lookback + 5, len(closes)):
        if pos == 0:
            lower = sma.iloc[i] - z_thresh * std.iloc[i]
            if closes.iloc[i] < lower and std.iloc[i] > 0:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                equity *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    return equity, trades, wins / max(1, trades)

# ===== 1. 横截面多空 (全样本 + 跨期) =====
print('\n===== 1. 横截面多空 (lookback=20, top30%, hold=5) =====')
eq, tr, wr = cross_sectional(data)
print(f'全样本: 终值{100}→{eq:.0f} | {tr}笔 | 胜率{wr*100:.1f}%')
# 跨期验证: 前70%调参, 后30%验证
n = len(data[next(iter(data))])
split = int(n * 0.7)
data_train = {s: d.iloc[:split] for s, d in data.items()}
data_test = {s: d.iloc[split:] for s, d in data.items()}
eq_tr, tr_tr, wr_tr = cross_sectional(data_train)
eq_te, tr_te, wr_te = cross_sectional(data_test)
print(f'训练期: {eq_tr:.0f} ({tr_tr}笔, {wr_tr*100:.1f}%) | 验证期: {eq_te:.0f} ({tr_te}笔, {wr_te*100:.1f}%)')

# ===== 2. 波动率突破 (全样本 + 跨期) =====
print('\n===== 2. 波动率突破 (ATR×1.5, hold=3) =====')
eqs, trs, wrs = [], 0, 0
for s, d in data.items():
    eq, t, w = vol_breakout(d)
    if eq: eqs.append(eq); trs += t; wrs += w * t
avg = np.mean(eqs) if eqs else 0
print(f'全样本平均终值: {avg:.0f} | 总{trs}笔 | 胜率{wrs/max(1,trs)*100:.1f}%')
eq_tr, tr_tr2, wr_tr2 = [], 0, 0
eq_te, tr_te2, wr_te2 = [], 0, 0
for s, d in data.items():
    e1, t1, w1 = vol_breakout(d.iloc[:split])
    e2, t2, w2 = vol_breakout(d.iloc[split:])
    if e1: eq_tr.append(e1); tr_tr2 += t1; wr_tr2 += w1 * t1
    if e2: eq_te.append(e2); tr_te2 += t2; wr_te2 += w2 * t2
print(f'训练期平均: {np.mean(eq_tr) if eq_tr else 0:.0f} ({tr_tr2}笔) | 验证期平均: {np.mean(eq_te) if eq_te else 0:.0f} ({tr_te2}笔)')

# ===== 3. 均值回归 (全样本 + 跨期) =====
print('\n===== 3. 均值回归 (布林2σ, hold=3) =====')
eqs3, trs3, wrs3 = [], 0, 0
for s, d in data.items():
    eq, t, w = mean_reversion(d)
    if eq: eqs3.append(eq); trs3 += t; wrs3 += w * t
avg3 = np.mean(eqs3) if eqs3 else 0
print(f'全样本平均终值: {avg3:.0f} | 总{trs3}笔 | 胜率{wrs3/max(1,trs3)*100:.1f}%')
eq_tr3, tr3a = [], 0
eq_te3, tr3b = [], 0
for s, d in data.items():
    e1, t1, _ = mean_reversion(d.iloc[:split])
    e2, t2, _ = mean_reversion(d.iloc[split:])
    if e1: eq_tr3.append(e1); tr3a += t1
    if e2: eq_te3.append(e2); tr3b += t2
print(f'训练期平均: {np.mean(eq_tr3) if eq_tr3 else 0:.0f} ({tr3a}笔) | 验证期平均: {np.mean(eq_te3) if eq_te3 else 0:.0f} ({tr3b}笔)')
