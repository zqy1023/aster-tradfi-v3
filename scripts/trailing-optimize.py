#!/usr/bin/env python3
"""移动止损阈值优化: 保本线/锁利线 提前 vs 延后
对比: (20/40), (30/60), (40/80), (50/100)
含成本, 止盈40%(上轮最优), 5年11标的
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE_TICK = 0.0015
FUNDING_DAY = 0.0003
LEVER = 3
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(path):
    df = pq.read_table(path).to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet')['close'] for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d for s, d in data.items()}).ffill()

def run_roll(year, be_pct, lock_pct, tp_pct=0.40):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None
    equity = 10000
    pos = None
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        spy_idx = spy.index.get_indexer([date], method='ffill')[0]
        if spy_idx < 200: continue
        spy200 = spy.iloc[spy_idx - 200:spy_idx].mean()
        spy20 = (spy.iloc[spy_idx] - spy.iloc[spy_idx - 20]) / spy.iloc[spy_idx - 20]
        strong_trend = spy.iloc[spy_idx] > spy200 and spy20 > 0
        strong_bear = spy.iloc[spy_idx] < spy200 and spy20 < 0
        if not (strong_trend or strong_bear):
            pos = None
            continue
        bull = strong_trend
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
                            'tp': entry * (1 + tp_pct) if bull else entry * (1 - tp_pct),
                            'stop': entry * 0.85 if bull else entry * 1.15,
                            'be': entry, 'hold': 0, 'trailed': False,
                            'be_pct': be_pct, 'lock_pct': lock_pct})
            if not pos: pos = None
        elif pos:
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                p['hold'] += 1
                w = 0.5
                funding = FUNDING_DAY * LEVER * w
                def close_ret(price_ret):
                    return price_ret * LEVER * w - FEE_TICK * LEVER * w * 2 - funding * p['hold']
                if p['dir'] == '多':
                    if price >= p['entry'] * (1 + p['be_pct']):
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if price >= p['entry'] * (1 + p['lock_pct']):
                        p['be'] = max(p['be'], p['entry'] * (1 + p['be_pct']))
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        equity *= (1 + ret); continue
                    if price >= p['tp']:
                        ret = close_ret(tp_pct)
                        equity *= (1 + ret); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); continue
                    else:
                        if price <= p['be']:
                            ret = close_ret((price - p['entry']) / p['entry'])
                            equity *= (1 + ret); continue
                else:
                    if price <= p['entry'] * (1 - p['be_pct']):
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * (1 - p['lock_pct']):
                        p['be'] = min(p['be'], p['entry'] * (1 - p['be_pct']))
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        equity *= (1 + ret); continue
                    if price <= p['tp']:
                        ret = close_ret(tp_pct)
                        equity *= (1 + ret); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); continue
                    else:
                        if price >= p['be']:
                            ret = close_ret((p['entry'] - price) / p['entry'])
                            equity *= (1 + ret); continue
                remaining.append(p)
            pos = remaining or None
    return equity

print('=== 移动止损阈值优化 (止盈40%, 含成本) ===')
print('保本/锁利 | 2022 | 2023 | 2024 | 2025 | 2026 | 5年平均')
configs = [(0.20, 0.40), (0.30, 0.60), (0.40, 0.80), (0.50, 1.00)]
for be, lock in configs:
    eqs = []
    line = f'{be*100:.0f}%/{lock*100:.0f}% |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq = run_roll(year, be, lock)
        eqs.append(eq)
        line += f' {eq:>6.0f} |'
    avg = np.mean(eqs)
    print(f'{line} {avg:>6.0f}')
