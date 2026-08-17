#!/usr/bin/env python3
"""滚仓v5 止盈参数优化: 找最优止盈目标
对比: 固定止盈(50/60/80/100/120%) vs 动态止盈(信号强度)
含真实成本(手续费0.1%+滑点0.2%+资金费0.03%/天), 3x杠杆, 15%止损
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

def run_roll(year, tp_pct):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None
    equity, trades = 10000, []
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
                            'be': entry, 'hold': 0, 'trailed': False})
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
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if price >= p['entry'] * 1.60:
                        p['be'] = max(p['be'], p['entry'] * 1.30)
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        equity *= (1 + ret); trades.append(ret); pos = None if len([q for q in remaining]) == 0 else None; continue
                    if price >= p['tp']:
                        ret = close_ret(tp_pct)
                        equity *= (1 + ret); trades.append(ret); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); trades.append(ret); continue
                    else:
                        if price <= p['be']:
                            ret = close_ret((price - p['entry']) / p['entry'])
                            equity *= (1 + ret); trades.append(ret); continue
                else:
                    if price <= p['entry'] * 0.70:
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * 0.40:
                        p['be'] = min(p['be'], p['entry'] * 0.70)
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        equity *= (1 + ret); trades.append(ret); continue
                    if price <= p['tp']:
                        ret = close_ret(tp_pct)
                        equity *= (1 + ret); trades.append(ret); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); trades.append(ret); continue
                    else:
                        if price >= p['be']:
                            ret = close_ret((p['entry'] - price) / p['entry'])
                            equity *= (1 + ret); trades.append(ret); continue
                remaining.append(p)
            pos = remaining or None
    return equity, len(trades)

print('=== 止盈目标参数扫描 (含成本, 5年汇总) ===')
print('止盈% | 2022 | 2023 | 2024 | 2025 | 2026 | 5年总终值')
for tp in [0.40, 0.60, 0.80, 1.00, 1.20]:
    eqs = []
    total_eq = 100
    line = f'{tp*100:>4.0f}% |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        r = run_roll(year, tp)
        if r:
            eq, n = r
            total_eq *= eq / 100  # 连乘
            line += f' {eq:>6.0f} |'
            eqs.append(eq)
    print(f'{line} {total_eq:>8.0f} ({(total_eq-100):+.0f}%)')
