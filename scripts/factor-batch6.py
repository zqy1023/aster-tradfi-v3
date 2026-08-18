#!/usr/bin/env python3
"""第6批因子: 波动/量价因子的极端窗口变体 + 对数变换 + 复合
目标: 补足50个有效因子(当前37个)
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

def compute_factors6(df):
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()
    log_ret = np.log(c / c.shift())
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)

    # 波动率更多窗口
    for n in [2, 14, 17, 19, 22, 24, 26, 28, 32, 50, 65, 75, 85, 100]:
        out[f'vol_{n}'] = ret.rolling(n).std()
    # 对数波动
    for n in [5, 10, 20]:
        out[f'logvol_{n}'] = log_ret.rolling(n).std()
    # 波动率平方根(半周期)
    out['vol_sqrt_10'] = np.sqrt((ret ** 2).rolling(10).mean())
    # ATR对数
    for n in [6, 8, 12, 16]:
        out[f'atrlog_{n}'] = np.log(1 + tr.rolling(n).mean() / c)
    # 量价复合
    for n in [4, 6, 8, 12]:
        out[f'vp_{n}'] = v.rolling(n).mean() / c.rolling(n).mean()
    # 量价×波动复合
    for n in [5, 10]:
        out[f'vpv_{n}'] = (v.rolling(n).mean() / c.rolling(n).mean()) * ret.rolling(n).std()
    # 高开低收位置
    out['hl_pos'] = (c - l) / (h - l + 1e-9)
    out['hl_pos_5'] = ((c - l) / (h - l + 1e-9)).rolling(5).mean()
    # 上影线比例
    out['upper_w'] = (h - np.maximum(o, c)) / (h - l + 1e-9)
    out['upper_w_5'] = ((h - np.maximum(o, c)) / (h - l + 1e-9)).rolling(5).mean()
    # 下影线比例
    out['lower_w'] = (np.minimum(o, c) - l) / (h - l + 1e-9)
    out['lower_w_5'] = ((np.minimum(o, c) - l) / (h - l + 1e-9)).rolling(5).mean()
    # 收益振幅
    out['range_pct'] = (h - l) / c
    for n in [3, 7]:
        out[f'range_{n}'] = ((h - l) / c).rolling(n).mean()
    # 成交额波动
    amt = c * v
    out['amt_vol_10'] = amt.pct_change().rolling(10).std()
    out['amt_vol_20'] = amt.pct_change().rolling(20).std()
    return out

def future_ret(df, h=5):
    return df['close'].shift(-h) / df['close'] - 1

from collections import defaultdict
agg = defaultdict(list)
for sym, df in data.items():
    factors = compute_factors6(df)
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

valid_list = []
for col, vals in agg.items():
    n = len(vals)
    avg_ic = np.mean([v[0] for v in vals])
    avg_ic1 = np.mean([v[1] for v in vals])
    avg_ic2 = np.mean([v[2] for v in vals])
    pos = sum(1 for v in vals if v[0] > 0)
    valid = avg_ic > 0.03 and avg_ic1 > 0 and avg_ic2 > 0 and pos > n * 0.5
    if valid:
        valid_list.append((col, avg_ic))
        print(f'✅ {col}: IC={avg_ic:.3f} 前{avg_ic1:.3f} 后{avg_ic2:.3f}')
print(f'\n第6批有效: {len(valid_list)}个')
for col, ic in valid_list:
    print(f'  {col}')
