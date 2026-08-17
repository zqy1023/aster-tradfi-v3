#!/usr/bin/env python3
"""v4 2026年亏损分析"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE = 0.0009
LEVER = 3
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(path):
    df = pq.read_table(path).to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet')['close'] for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d for s, d in data.items()}).ffill()

# 简化版: 只记录2026每笔, 看是追高还是止损
c = closes[(closes.index >= '2026-01-01') & (closes.index < '2027-01-01')]
equity, trades = 10000, []
pos = None
for i in range(20, len(c)):
    date = c.index[i]
    day = c.iloc[i]
    spy_idx = spy.index.get_indexer([date], method='ffill')[0]
    if spy_idx < 200: continue
    bull = spy.iloc[spy_idx] > spy.iloc[spy_idx - 200:spy_idx].mean()
    if pos is None:
        mom = {}
        for s in SYMS:
            cc = c[s].dropna()
            idx = cc.index.get_indexer([date], method='ffill')[0]
            if idx >= 20 and cc.iloc[idx] > 0:
                mom[s] = (cc.iloc[idx] - cc.iloc[idx - 20]) / cc.iloc[idx - 20]
        if len(mom) < 2: continue
        ranked = sorted(mom, key=mom.get, reverse=True)
        picks = ranked[:2] if bull else ranked[-2:]
        pos = []
        for s in picks:
            entry = day[s]
            if np.isnan(entry) or entry <= 0: continue
            pos.append({'sym': s, 'dir': '多' if bull else '空', 'entry': entry,
                        'tp': entry * 1.80 if bull else entry * 0.20,
                        'stop': entry * 0.85 if bull else entry * 1.15, 'hold': 0})
        if not pos: pos = None
    elif pos:
        remaining = []
        for p in pos:
            price = day[p['sym']]
            if np.isnan(price): remaining.append(p); continue
            p['hold'] += 1
            w = 0.5
            if p['dir'] == '多':
                if price <= p['stop']:
                    ret = -0.15 * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '多', '止损', ret, equity)); continue
                if price >= p['tp']:
                    ret = 0.80 * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '多', '止盈', ret, equity)); continue
                if p['hold'] >= 10:
                    ret = (price - p['entry']) / p['entry'] * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '多', '超时', ret, equity)); continue
            else:
                if price >= p['stop']:
                    ret = -0.15 * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '空', '止损', ret, equity)); continue
                if price <= p['tp']:
                    ret = 0.80 * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '空', '止盈', ret, equity)); continue
                if p['hold'] >= 10:
                    ret = (p['entry'] - price) / p['entry'] * LEVER * w - FEE * LEVER * w
                    equity *= (1 + ret); trades.append((date, p['sym'], '空', '超时', ret, equity)); continue
            remaining.append(p)
        pos = remaining or None

print(f'2026 v4: 期末 {equity:,.0f} | {(equity/10000-1)*100:+.1f}% | {len(trades)}笔')
wins = sum(1 for t in trades if t[4] > 0)
print(f'盈{wins} 亏{len(trades)-wins}')
# 按类型统计
from collections import Counter
types = Counter(t[3] for t in trades)
print('类型分布:', dict(types))
# 看每笔
for t in trades:
    print(f"  {t[0].strftime('%m-%d')} {t[1]:>7} {t[2]} {t[3]} | {t[4]*100:+.1f}%")
