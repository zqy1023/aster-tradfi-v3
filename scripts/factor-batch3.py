#!/usr/bin/env python3
"""第3批因子: 横截面因子 + 动量多窗口变体 + 波动多形式
目标: 扩充到50个候选, 找出所有IC>0.03跨期稳定的
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
closes = pd.DataFrame({s: d['close'] for s, d in data.items()}).ffill()

def compute_factors3(sym, df, cross):
    """第3批: 含横截面因子(cross = 全标的面板)"""
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()

    # === 动量变体(指数衰减/加权) ===
    for n in [5, 10, 20, 40, 80]:
        out[f'mom_ewm_{n}'] = c.pct_change(n)  # 基础
    out['mom_20_5'] = c.pct_change(20) - c.pct_change(5)  # 中期-短期
    out['mom_60_20'] = c.pct_change(60) - c.pct_change(20)
    out['mom_20_std'] = c.pct_change(20) / (ret.rolling(20).std() + 1e-9)  # 动量/波动(夏普式)
    out['mom_20_10std'] = c.pct_change(20) / (ret.rolling(10).std() + 1e-9)

    # === 波动变体 ===
    for n in [7, 15, 40]:
        out[f'vol_{n}'] = ret.rolling(n).std()
    out['vol_high_low'] = (h - l) / c  # 日内波动
    out['vol_high_low_5'] = ((h - l) / c).rolling(5).mean()
    out['vol_sq'] = (ret ** 2).rolling(20).mean() ** 0.5  # 平方波动
    out['vol_neg'] = ret.where(ret < 0).rolling(20).std()  # 下行波动
    out['vol_pos'] = ret.where(ret > 0).rolling(20).std()  # 上行波动
    out['vol_skew_ratio'] = out['vol_pos'] / (out['vol_neg'] + 1e-9)  # 上/下行波动比

    # === 量价变体 ===
    out['volume_z'] = (v - v.rolling(20).mean()) / v.rolling(20).std()
    out['volume_trend'] = v.rolling(5).mean() / v.rolling(60).mean()
    out['amt_20'] = (c * v).rolling(20).mean()  # 成交额
    out['amt_ratio'] = (c * v).rolling(5).mean() / ((c * v).rolling(60).mean() + 1e-9)

    # === 横截面因子(跨标的) ===
    # 相对动量排名
    for n in [5, 10, 20]:
        mom_col = f'cross_mom_{n}'
        mom_panel = closes.pct_change(n)
        out[mom_col] = mom_panel[sym]
    # 截面波动排名
    vol_panel = closes.pct_change().rolling(20).std()
    out['cross_vol'] = vol_panel[sym]
    # 相对强度 vs 中位数
    mom20 = closes.pct_change(20)
    out['rel_vs_median'] = mom20[sym] - mom20.median(axis=1)

    # === 统计变体 ===
    out['skew_10'] = ret.rolling(10).skew()
    out['skew_60'] = ret.rolling(60).skew()
    out['kurt_10'] = ret.rolling(10).kurt()
    out['autocorr_5'] = ret.rolling(20).apply(lambda x: np.corrcoef(x[:-1], x[1:])[0, 1] if len(x) > 2 else 0, raw=True)

    # === 蜡烛形态 ===
    out['doji'] = (abs(c - o) / (h - l + 1e-9) < 0.1).astype(float)
    out['hammer'] = ((l - np.minimum(o, c)) / (h - l + 1e-9) > 0.6).astype(float)
    out['engulf_5'] = ((c > o) & (c.shift() < o.shift())).astype(float).rolling(5).sum()

    # === 时间特征 ===
    out['day_of_week'] = df.index.dayofweek / 6
    out['month'] = df.index.month / 12
    out['days_since_high'] = (c.rolling(60).apply(lambda x: len(x) - np.argmax(x), raw=True)) / 60
    out['days_since_low'] = (c.rolling(60).apply(lambda x: len(x) - np.argmin(x), raw=True)) / 60

    return out

def future_ret(df, h=5):
    return df['close'].shift(-h) / df['close'] - 1

from collections import defaultdict
agg = defaultdict(list)
for sym, df in data.items():
    factors = compute_factors3(sym, df, closes)
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

print(f'{"因子":>18} | {"全期IC":>7} | {"前5年":>7} | {"后5年":>7} | {"正标":>4} | 判定')
print('-' * 65)
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
    print(f'{col:>18} | {avg_ic:7.3f} | {avg_ic1:7.3f} | {avg_ic2:7.3f} | {pos:>3}/{n} | {mark}')
print(f'\n第3批有效: {len(valid_list)}个: {", ".join(valid_list)}')
