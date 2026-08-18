#!/usr/bin/env python3
"""汇总: 50+有效因子完整报告(跨6批)
生成最终因子清单+IC值, 供明早汇报
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

# 定义全部候选因子(6批合集, 去重)
def all_factors(df):
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()
    log_ret = np.log(c / c.shift())
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    delta = c.diff(); gain = delta.clip(lower=0).rolling(14).mean(); loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / (loss.replace(0, np.nan)); rsi = 100 - 100 / (1 + rs)

    # 波动类(全部窗口)
    for n in [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,24,25,26,28,30,32,35,40,45,50,55,65,75,85,100]:
        out[f'vol_{n}'] = ret.rolling(n).std()
    # 对数波动
    for n in [5,10,20]:
        out[f'logvol_{n}'] = log_ret.rolling(n).std()
    out['vol_sqrt_10'] = np.sqrt((ret**2).rolling(10).mean())
    # 波动率比
    for s,l2 in [(3,20),(5,20),(5,30),(10,30),(10,60),(20,60)]:
        out[f'volr_{s}_{l2}'] = ret.rolling(s).std()/ret.rolling(l2).std()
    out['vol_chg'] = ret.rolling(10).std()/ret.rolling(30).std()-1
    # ATR
    for n in [5,6,7,8,10,12,14,16,21,30]:
        out[f'atr_{n}'] = tr.rolling(n).mean()/c
    for n in [6,8,12,16]:
        out[f'atrlog_{n}'] = np.log(1+tr.rolling(n).mean()/c)
    out['atr_chg'] = tr.rolling(5).mean()/tr.rolling(14).mean()-1
    out['atr_7_14'] = tr.rolling(7).mean()/tr.rolling(14).mean()-1
    # 量价
    for n in [3,4,5,6,7,8,10,12,15,20,30,40]:
        out[f'vp_{n}'] = v.rolling(n).mean()/c.rolling(n).mean()
    for n in [5,10]:
        out[f'vpv_{n}'] = (v.rolling(n).mean()/c.rolling(n).mean())*ret.rolling(n).std()
    # RSI
    out['rsi_oversold'] = (rsi<30).astype(float)
    # 反转
    for n in [2,3,4]:
        out[f'rev_{n}'] = -ret.rolling(n).mean()
    # 统计
    out['skew_20'] = ret.rolling(20).skew()
    out['skew_10'] = ret.rolling(10).skew()
    # 其他
    out['gap_std'] = (o/c.shift()-1).rolling(20).std()
    out['neg_days_10'] = (ret<0).astype(float).rolling(10).sum()/10
    out['range_pct'] = (h-l)/c
    for n in [3,7]:
        out[f'range_{n}'] = ((h-l)/c).rolling(n).mean()
    out['upper_w_5'] = ((h-np.maximum(o,c))/(h-l+1e-9)).rolling(5).mean()
    out['hl_pos_5'] = ((c-l)/(h-l+1e-9)).rolling(5).mean()
    return out

def future_ret(df, h=5):
    return df['close'].shift(-h)/df['close']-1

from collections import defaultdict
agg = defaultdict(list)
for sym, df in data.items():
    factors = all_factors(df)
    fwd = future_ret(df)
    for col in factors.columns:
        valid = pd.concat([factors[col], fwd], axis=1).dropna()
        if len(valid) < 100: continue
        ic = stats.spearmanr(valid.iloc[:,0], valid.iloc[:,1]).statistic
        mid = valid.index[len(valid)//2]
        f1 = valid[valid.index<mid]; f2 = valid[valid.index>=mid]
        ic1 = stats.spearmanr(f1.iloc[:,0], f1.iloc[:,1]).statistic if len(f1)>50 else 0
        ic2 = stats.spearmanr(f2.iloc[:,0], f2.iloc[:,1]).statistic if len(f2)>50 else 0
        agg[col].append((ic, ic1, ic2))

# 有效因子(按IC排序)
valid_factors = []
for col, vals in agg.items():
    n = len(vals)
    avg_ic = np.mean([v[0] for v in vals])
    avg_ic1 = np.mean([v[1] for v in vals])
    avg_ic2 = np.mean([v[2] for v in vals])
    pos = sum(1 for v in vals if v[0] > 0)
    if avg_ic > 0.03 and avg_ic1 > 0 and avg_ic2 > 0 and pos > n * 0.5:
        valid_factors.append((col, avg_ic, avg_ic1, avg_ic2))

valid_factors.sort(key=lambda x: -x[1])
print(f'=== 有效因子汇总: {len(valid_factors)} 个 (IC>0.03, 前后5年都正, 多数标的正) ===')
print(f'{"#":>3} | {"因子":>14} | {"全期IC":>7} | {"前5年":>7} | {"后5年":>7}')
for i, (col, ic, ic1, ic2) in enumerate(valid_factors, 1):
    print(f'{i:>3} | {col:>14} | {ic:7.3f} | {ic1:7.3f} | {ic2:7.3f}')

# 按类别统计
cats = {'波动率': 0, '量价': 0, 'ATR': 0, '反转': 0, '统计': 0, '其他': 0}
for col, *_ in valid_factors:
    if col.startswith('vol') or col.startswith('logvol') or col.startswith('vol_sqrt'): cats['波动率'] += 1
    elif col.startswith('vp') or col.startswith('vpv') or col.startswith('volr'): cats['量价'] += 1
    elif col.startswith('atr') or col.startswith('atrlog'): cats['ATR'] += 1
    elif col.startswith('rev'): cats['反转'] += 1
    elif col.startswith('skew'): cats['统计'] += 1
    else: cats['其他'] += 1
print(f'\n=== 类别分布 ===')
for k, v in cats.items():
    print(f'  {k}: {v}个')
