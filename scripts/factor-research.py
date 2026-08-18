#!/usr/bin/env python3
"""因子批量研究: 50+候选因子的IC检验
数据: Yahoo 10年日线(11标的)
方法: 每因子计算 t 日值 vs 未来 h 日收益的 IC(斯皮尔曼秩相关)
标准: IC > 0.03 且 前5年/后5年都正 = 有效
输出: 全部因子的IC排序
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

# 加载全部
data = {s: load(s) for s in SYMS}

def compute_factors(df):
    """计算所有候选因子, 返回DataFrame"""
    c = df['close']
    h = df['high']
    l = df['low']
    v = df['volume']
    o = df['open']
    out = pd.DataFrame(index=df.index)
    
    # === 动量类 ===
    for n in [3, 5, 10, 20, 30, 60]:
        out[f'mom_{n}'] = c.pct_change(n)
    # 动量加速度(动量的一阶差分)
    out['mom_accel'] = c.pct_change(5) - c.pct_change(10)
    # 远期动量(20-60日)
    out['mom_20_60'] = c.pct_change(20) - c.pct_change(60)
    
    # === 反转类 ===
    for n in [1, 2, 3, 5]:
        out[f'rev_{n}'] = -c.pct_change(n)  # 短期反转(负动量)
    
    # === 波动率类 ===
    for n in [5, 10, 20, 30]:
        out[f'vol_{n}'] = c.pct_change().rolling(n).std()
    # 波动率变化
    out['vol_chg'] = c.pct_change().rolling(10).std() / c.pct_change().rolling(30).std() - 1
    # 已实现波动 vs 历史
    out['vol_ratio'] = c.pct_change().rolling(5).std() / c.pct_change().rolling(60).std()
    
    # === 量价类 ===
    for n in [5, 10, 20]:
        out[f'volratio_{n}'] = v.rolling(n).mean() / v.rolling(60).mean()
        out[f'vol_price_{n}'] = v.rolling(n).mean() / c.rolling(n).mean()  # 量价比
    # OBV
    obv = (np.sign(c.diff()) * v).cumsum()
    out['obv_slope'] = obv.rolling(20).mean().pct_change(5)
    # 量价背离
    out['price_vol_div'] = c.pct_change(5) - (v.rolling(5).mean().pct_change(5) / 10)
    
    # === 技术指标 ===
    # RSI
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    out['rsi_14'] = 100 - 100 / (1 + rs)
    out['rsi_oversold'] = (out['rsi_14'] < 30).astype(float)  # 超卖
    out['rsi_overbought'] = (out['rsi_14'] > 70).astype(float)  # 超买
    
    # 均线关系
    for n in [5, 10, 20, 50, 200]:
        out[f'ma_{n}'] = c / c.rolling(n).mean() - 1  # 价格偏离均线
    out['ma_cross_5_20'] = (c.rolling(5).mean() / c.rolling(20).mean() - 1)
    out['ma_cross_20_50'] = (c.rolling(20).mean() / c.rolling(50).mean() - 1)
    out['ma_align'] = (c > c.rolling(5).mean()).astype(float) + (c.rolling(5).mean() > c.rolling(20).mean()).astype(float) + (c.rolling(20).mean() > c.rolling(50).mean()).astype(float)
    
    # 布林带
    ma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    out['bb_pos'] = (c - ma20) / (2 * std20)  # 布林位置
    out['bb_width'] = (2 * std20) / ma20  # 布林带宽
    
    # MACD
    ema12 = c.ewm(span=12).mean()
    ema26 = c.ewm(span=26).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9).mean()
    out['macd'] = (macd - signal) / c  # 归一化
    out['macd_hist_chg'] = (macd - signal).diff(3) / c
    
    # ATR
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    out['atr_pct'] = tr.rolling(14).mean() / c
    out['atr_chg'] = tr.rolling(5).mean() / tr.rolling(14).mean() - 1
    
    # 唐奇安通道位置
    out['donchian_pos'] = (c - l.rolling(20).min()) / (h.rolling(20).max() - l.rolling(20).min())
    
    # 上影线/下影线
    out['upper_shadow'] = (h - np.maximum(o, c)) / (h - l + 1e-9)
    out['lower_shadow'] = (np.minimum(o, c) - l) / (h - l + 1e-9)
    out['body_ratio'] = (c - o) / (h - l + 1e-9)
    
    # 连续涨跌
    out['up_streak'] = (c > c.shift()).astype(int).rolling(5).sum()
    out['down_streak'] = (c < c.shift()).astype(int).rolling(5).sum()
    
    # === 截面类(需要跨标的, 这里先单标的) ===
    # 相对强度(对自身20日均线)
    out['rel_strength'] = c.pct_change(20) / c.pct_change(20).rolling(60).std()
    
    return out

# 未来收益
HORIZON = 5  # 5日未来收益

def future_ret(df, h=HORIZON):
    return df['close'].shift(-h) / df['close'] - 1

print('=== 因子IC检验 (未来5日收益, 11标的) ===')
print(f'{"因子":>20} | {"全期IC":>7} | {"前5年IC":>8} | {"后5年IC":>8} | 判定')
print('-' * 60)

results = []
for sym, df in data.items():
    factors = compute_factors(df)
    fwd = future_ret(df)
    for col in factors.columns:
        valid = pd.concat([factors[col], fwd], axis=1).dropna()
        if len(valid) < 100: continue
        ic = stats.spearmanr(valid.iloc[:, 0], valid.iloc[:, 1]).statistic
        # 前后5年
        mid = valid.index[len(valid) // 2]
        f1 = valid[valid.index < mid]
        f2 = valid[valid.index >= mid]
        ic1 = stats.spearmanr(f1.iloc[:, 0], f1.iloc[:, 1]).statistic if len(f1) > 50 else 0
        ic2 = stats.spearmanr(f2.iloc[:, 0], f2.iloc[:, 1]).statistic if len(f2) > 50 else 0
        results.append((col, ic, ic1, ic2, sym))

# 汇总: 按因子名聚合(跨标的平均)
from collections import defaultdict
agg = defaultdict(list)
for col, ic, ic1, ic2, sym in results:
    agg[col].append((ic, ic1, ic2))

print(f'候选因子数: {len(agg)}')
print(f'{"因子":>20} | {"全期IC":>7} | {"前5年":>7} | {"后5年":>7} | {"正标":>4} | 判定')
print('-' * 70)
summary = []
for col, vals in agg.items():
    n = len(vals)
    avg_ic = np.mean([v[0] for v in vals])
    avg_ic1 = np.mean([v[1] for v in vals])
    avg_ic2 = np.mean([v[2] for v in vals])
    pos_count = sum(1 for v in vals if v[0] > 0)
    valid = avg_ic > 0.03 and avg_ic1 > 0 and avg_ic2 > 0 and pos_count > n * 0.5
    mark = '✅有效' if valid else ''
    summary.append((col, avg_ic, avg_ic1, avg_ic2, pos_count, n, valid))
    print(f'{col:>20} | {avg_ic:7.3f} | {avg_ic1:7.3f} | {avg_ic2:7.3f} | {pos_count:>3}/{n} | {mark}')

valid_count = sum(1 for s in summary if s[6])
print(f'\n=== 有效因子数: {valid_count} / {len(summary)} ===')
