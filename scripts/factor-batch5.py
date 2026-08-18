#!/usr/bin/env python3
"""第5批因子: 多周期+缺口+周内效应+动量波动比
目标: 补足到50个有效因子
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np
from scipy import stats

SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(s) for s in SYMS}

def compute_factors5(df):
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()

    # 多周期收益
    for n in [2, 3, 4, 6, 8, 12, 15, 25, 35, 45, 55, 70, 90]:
        out[f'ret_{n}'] = c.pct_change(n)
    # 缺口
    out['gap'] = o / c.shift() - 1
    out['gap_5'] = (o / c.shift() - 1).rolling(5).mean()
    out['gap_std'] = (o / c.shift() - 1).rolling(20).std()
    # 开盘后方向
    out['open_pos'] = (c > o).astype(float)
    out['open_pos_5'] = (c > o).astype(float).rolling(5).mean()
    # 周内效应
    dow = df.index.dayofweek
    out['dow_mon'] = (dow == 0).astype(float)
    out['dow_fri'] = (dow == 4).astype(float)
    # 动量波动比(夏普式)
    out['mom_vol_10'] = c.pct_change(10) / (ret.rolling(10).std() + 1e-9)
    out['mom_vol_20'] = c.pct_change(20) / (ret.rolling(20).std() + 1e-9)
    out['mom_vol_30'] = c.pct_change(30) / (ret.rolling(30).std() + 1e-9)
    # 收益持续性
    out['pos_days_10'] = (ret > 0).astype(float).rolling(10).sum() / 10
    out['neg_days_10'] = (ret < 0).astype(float).rolling(10).sum() / 10
    out['up_down_ratio'] = (ret > 0).astype(float).rolling(20).sum() / ((ret < 0).astype(float).rolling(20).sum() + 1e-9)
    # 波动率与收益比
    out['vol_ret_ratio'] = ret.rolling(20).std() / (abs(ret).rolling(20).mean() + 1e-9)
    # 价格位置
    out['pos_20'] = (c - l.rolling(20).min()) / (h.rolling(20).max() - l.rolling(20).min() + 1e-9)
    out['pos_50'] = (c - l.rolling(50).min()) / (h.rolling(50).max() - l.rolling(50).min() + 1e-9)
    # 布林位置变体
    ma20 = c.rolling(20).mean(); sd20 = c.rolling(20).std()
    out['bb_pos_2'] = (c - ma20) / (2 * sd20 + 1e-9)
    # 通道突破
    out['break_20h'] = (c > h.rolling(20).max().shift()).astype(float)
    out['break_20l'] = (c < l.rolling(20).min().shift()).astype(float)
    # ATR通道
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr14 = tr.rolling(14).mean()
    out['atr_band_pos'] = (c - (ma20 - atr14)) / (2 * atr14 + 1e-9)
    return out

def future_ret(df, h=5):
    return df['close'].shift(-h) / df['close'] - 1

from collections import defaultdict
agg = defaultdict(list)
for sym, df in data.items():
    factors = compute_factors5(df)
    fwd = future_ret(df)
    for col in factors.columns:
        valid = pd.concat([factors[col], fwd], axis=1).dropna()
        if len(valid) < 100: continue
        ic = stats.spearmanr(valid.iloc[:, 0], valid.iloc[:, 1]).statistic
        mid = valid.index[len(valid) // 2]
        f1 = valid[valid.index < mid]
        f2 = valid[valid.index >= mid]
        ic1 = stats.spearmanr(f1.iloc[:, 0], f1.iloc[:, 1]).statistic if len(f1) > 50 else 0
        ic2 = stats.spearmanr(f2.iloc[:, 0], f2.iloc[:, 1]).statistic if len(f2) > 50 else 0
        agg[col].append((ic, ic1, ic2))

print(f'候选: {len(agg)}')
print(f'{"因子":>14} | {"全期IC":>7} | {"前5年":>7} | {"后5年":>7} | {"正标":>4} | 判定')
print('-' * 60)
valid_list = []
for col, vals in agg.items():
    n = len(vals)
    avg_ic = np.mean([v[0] for v in vals])
    avg_ic1 = np.mean([v[1] for v in vals])
    avg_ic2 = np.mean([v[2] for v in vals])
    pos = sum(1 for v in vals if v[0] > 0)
    valid = avg_ic > 0.03 and avg_ic1 > 0 and avg_ic2 > 0 and pos > n * 0.5
    mark = '✅' if valid else ''
    if valid: valid_list.append(col)
    print(f'{col:>14} | {avg_ic:7.3f} | {avg_ic1:7.3f} | {avg_ic2:7.3f} | {pos:>3}/{n} | {mark}')
print(f'\n第5批有效: {len(valid_list)}个: {", ".join(valid_list)}')
