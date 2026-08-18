#!/usr/bin/env python3
"""第4批因子: 大量窗口变体+组合因子
目标: 从10个有效因子扩到50个
方法: 对已验证有效的基础因子(波动/量价/反转), 生成大量参数变体
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

def compute_factors4(df):
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()

    # === 波动率全窗口变体(有效基础: vol) ===
    for n in [3, 4, 6, 7, 8, 9, 11, 12, 13, 15, 16, 18, 21, 25, 35, 40, 45, 55]:
        out[f'vol_{n}'] = ret.rolling(n).std()
    # 波动率比(短/长)
    for s, l2 in [(3, 20), (5, 20), (5, 30), (10, 30), (10, 60), (20, 60)]:
        out[f'volr_{s}_{l2}'] = ret.rolling(s).std() / ret.rolling(l2).std()

    # === 量价比全窗口变体(有效基础: vol_price) ===
    for n in [3, 5, 7, 10, 15, 20, 30, 40]:
        out[f'vp_{n}'] = v.rolling(n).mean() / c.rolling(n).mean()
    # 量比
    for n in [3, 5, 10, 15, 20]:
        out[f'vr_{n}'] = v.rolling(n).mean() / (v.rolling(60).mean() + 1e-9)

    # === ATR变体(有效基础: atr) ===
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    for n in [5, 7, 10, 14, 21, 30]:
        out[f'atr_{n}'] = tr.rolling(n).mean() / c
    out['atr_7_14'] = tr.rolling(7).mean() / tr.rolling(14).mean() - 1

    # === 反转变体(短期) ===
    for n in [2, 3, 4, 6, 7, 8]:
        out[f'rev_{n}'] = -ret.rolling(n).mean()

    # === 组合因子 ===
    # 波动+反转组合
    out['vol_rev_5'] = ret.rolling(5).std() * -ret.rolling(5).mean()
    out['vol_rev_10'] = ret.rolling(10).std() * -ret.rolling(10).mean()
    # 量价+波动
    out['vp_vol_5'] = (v.rolling(5).mean() / c.rolling(5).mean()) * ret.rolling(5).std()
    # 波动乖离
    out['vol_dev_20'] = ret.rolling(5).std() / ret.rolling(20).std() - 1

    return out

def future_ret(df, h=5):
    return df['close'].shift(-h) / df['close'] - 1

from collections import defaultdict
agg = defaultdict(list)
for sym, df in data.items():
    factors = compute_factors4(df)
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
print(f'\n第4批有效: {len(valid_list)}个: {", ".join(valid_list)}')
