#!/usr/bin/env python3
"""57个有效因子的策略可用性测试
方法: 每个因子按值分5组(quintile), 计算最高组vs最低组未来5日收益差(多空价差)
标准: 分组单调性(高组>低组) + 最高组绝对收益>0 + 跨期稳定
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

def all_factors(df):
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']; o = df['open']
    out = pd.DataFrame(index=df.index)
    ret = c.pct_change()
    log_ret = np.log(c / c.shift())
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    delta = c.diff(); gain = delta.clip(lower=0).rolling(14).mean(); loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / (loss.replace(0, np.nan)); rsi = 100 - 100 / (1 + rs)
    for n in [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,24,25,26,28,30,32,35,40,45,50,55,65,75,85,100]:
        out[f'vol_{n}'] = ret.rolling(n).std()
    for n in [5,10,20]:
        out[f'logvol_{n}'] = log_ret.rolling(n).std()
    out['vol_sqrt_10'] = np.sqrt((ret**2).rolling(10).mean())
    for s,l2 in [(3,20),(5,20),(5,30),(10,30),(10,60),(20,60)]:
        out[f'volr_{s}_{l2}'] = ret.rolling(s).std()/ret.rolling(l2).std()
    out['vol_chg'] = ret.rolling(10).std()/ret.rolling(30).std()-1
    for n in [5,6,7,8,10,12,14,16,21,30]:
        out[f'atr_{n}'] = tr.rolling(n).mean()/c
    for n in [6,8,12,16]:
        out[f'atrlog_{n}'] = np.log(1+tr.rolling(n).mean()/c)
    out['atr_chg'] = tr.rolling(5).mean()/tr.rolling(14).mean()-1
    out['atr_7_14'] = tr.rolling(7).mean()/tr.rolling(14).mean()-1
    for n in [3,4,5,6,7,8,10,12,15,20,30,40]:
        out[f'vp_{n}'] = v.rolling(n).mean()/c.rolling(n).mean()
    for n in [5,10]:
        out[f'vpv_{n}'] = (v.rolling(n).mean()/c.rolling(n).mean())*ret.rolling(n).std()
    out['rsi_oversold'] = (rsi<30).astype(float)
    for n in [2,3,4]:
        out[f'rev_{n}'] = -ret.rolling(n).mean()
    out['skew_20'] = ret.rolling(20).skew()
    out['skew_10'] = ret.rolling(10).skew()
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

# 用第1批的57个有效因子名单
VALID = ['vpv_10','vpv_5','vp_6','vp_5','vp_4','vp_7','vp_8','vp_3','vp_10','atr_6','atrlog_6','vp_20','vp_12','atr_7','atr_5','vp_15','atr_8','atrlog_8','range_7','vp_30','atr_7_14','vp_40','volr_10_30','vol_chg','atr_10','range_3','vol_sqrt_10','vol_10','vol_8','logvol_10','vol_9','vol_11','atr_12','atrlog_12','neg_days_10','vol_7','atr_chg','vol_12','vol_6','range_pct','atr_14','vol_65','vol_13','gap_std','vol_50','vol_55','vol_14','atr_21','atr_16','atrlog_16','vol_5','logvol_5','vol_15','vol_85','skew_20','rsi_oversold','vol_24']

print('=== 57因子分组回测: 高组vs低组未来5日收益 ===')
print(f'{"因子":>14} | {"Q1(低)":>7} | {"Q5(高)":>7} | {"价差":>7} | {"单调":>4} | 可用')
print('-'*62)

usable = []
for fac in VALID:
    q_ret = {1: [], 5: []}
    monotonic = True
    for sym, df in data.items():
        factors = all_factors(df)
        fwd = future_ret(df)
        valid = pd.concat([factors[fac], fwd], axis=1).dropna()
        if len(valid) < 200: continue
        try:
            q = pd.qcut(valid.iloc[:, 0], 5, labels=[1,2,3,4,5], duplicates='drop')
        except ValueError:
            continue  # 离散因子分不出5组, 跳过
        if q is None or len(pd.Series(q).dropna()) == 0: continue
        for grp in [1, 5]:
            sub = valid[q == grp]
            if len(sub) > 10:
                q_ret[grp].append(sub.iloc[:, 1].mean())
    if not q_ret[1] or not q_ret[5]: continue
    q1 = np.mean(q_ret[1]); q5 = np.mean(q_ret[5])
    spread = q5 - q1
    mono = q5 > q1
    # 可用标准: 高组正收益 + 价差>0.2%(可覆盖成本) + 单调
    usable_flag = q5 > 0 and spread > 0.002 and mono
    if usable_flag: usable.append((fac, q1, q5, spread))
    print(f'{fac:>14} | {q1*100:6.2f}% | {q5*100:6.2f}% | {spread*100:5.2f}% | {"✓" if mono else "✗"} | {"✅" if usable_flag else ""}')

print(f'\n=== 可直接用因子: {len(usable)}个 ===')
for fac, q1, q5, spread in sorted(usable, key=lambda x: -x[3]):
    print(f'  {fac}: 高组{q5*100:+.2f}%/5日, 价差{spread*100:+.2f}%')
