#!/usr/bin/env python3
"""动量策略失败模式诊断: 什么条件下动量亏钱
核心问题: 追高进场吃大回调
诊断: 动量#1进场后, 未来1/3/5/10日收益分布
      → 看追高的代价有多大
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(s) for s in SYMS}
closes = pd.DataFrame({s: d['close'] for s, d in data.items()}).ffill()

print('=== 动量追高诊断: 动量#1进场后未来收益 ===')
print('(动量#1 = 20日涨幅排名第1的标的)')

# 统计: 动量排名 vs 未来收益
all_rows = []
for i in range(20, len(closes) - 10):
    date = closes.index[i]
    mom = closes.iloc[i - 20:i].pct_change().sum()  # 简化20日动量
    ranked = mom.dropna().rank(ascending=False)
    for sym in closes.columns:
        if sym not in mom.index or pd.isna(mom[sym]): continue
        rank = ranked[sym]
        if rank > 4: continue  # 只看前4
        fwd1 = closes[sym].iloc[i + 1] / closes[sym].iloc[i] - 1
        fwd3 = closes[sym].iloc[i + 3] / closes[sym].iloc[i] - 1
        fwd5 = closes[sym].iloc[i + 5] / closes[sym].iloc[i] - 1
        fwd10 = closes[sym].iloc[i + 10] / closes[sym].iloc[i] - 1
        all_rows.append({'rank': int(rank), 'fwd1': fwd1, 'fwd3': fwd3, 'fwd5': fwd5, 'fwd10': fwd10})

df = pd.DataFrame(all_rows)
print(f'样本: {len(df)} 次动量#1-#4进场')
print('\n=== 按排名分组的未来收益(中位数%) ===')
for r in [1, 2, 3, 4]:
    sub = df[df['rank'] == r]
    print(f'排名#{r}: 1日{sub["fwd1"].median()*100:+.2f}% | 3日{sub["fwd3"].median()*100:+.2f}% | 5日{sub["fwd5"].median()*100:+.2f}% | 10日{sub["fwd10"].median()*100:+.2f}%')

print('\n=== 追高代价: 进场后5日内最大回撤 ===')
# 进场后5日最低点 vs 进场价
dds = []
for i in range(20, len(closes) - 5):
    date = closes.index[i]
    mom = closes.iloc[i - 20:i].pct_change().sum()
    ranked = mom.dropna().rank(ascending=False)
    for sym in closes.columns:
        if sym not in mom.index or pd.isna(mom[sym]): continue
        if ranked[sym] != 1: continue
        entry = closes[sym].iloc[i]
        low5 = closes[sym].iloc[i:i + 5].min()
        dds.append((low5 / entry - 1))
dd = pd.Series(dds)
print(f'动量#1进场后5日内最大回撤: 中位数{dd.median()*100:.1f}% | 25分位{dd.quantile(0.25)*100:.1f}% | 最差{dd.min()*100:.1f}%')
print(f'→ 追高进场, 5日内有{ (dd < -0.05).mean()*100:.0f}%概率回撤超5%')

print('\n=== 结论 ===')
print('如果5日内回撤>5%的概率很高 → 追高动量=吃回调')
print('需要: 回踩进场/分批建仓/回调后再进')
