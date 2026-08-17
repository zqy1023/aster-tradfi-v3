#!/usr/bin/env python3
"""滚仓v8: 动态杠杆(趋势强度切换) + 动态仓位
杠杆: SPY 20日动量>10% → 8x; 2-10% → 5x; <2% → 3x
同时: 动量#1 60%/#2 40% + ATR自适应止损 + 动态止损锁利
对比: 固定5x vs 动态杠杆
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE_TICK = 0.0015
FUNDING_DAY = 0.0003
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(path):
    df = pq.read_table(path).to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet')['close'] for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d for s, d in data.items()}).ffill()

atr_cache = {}
for s in SYMS:
    c = data[s].dropna()
    tr = pd.concat([c.diff(), c - c.rolling(2).max().shift(), c.rolling(2).min().shift() - c], axis=1).max(axis=1)
    atr_cache[s] = (tr.rolling(20).mean() / c).dropna()

def dyn_lever(spy20mom):
    if spy20mom > 0.10: return 8
    if spy20mom > 0.02: return 5
    return 3

def run_roll(year, use_dyn_lever=True):
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
        spy20mom = (spy.iloc[spy_idx] - spy.iloc[spy_idx - 20]) / spy.iloc[spy_idx - 20]
        lever = dyn_lever(spy20mom) if use_dyn_lever else 5
        strong_trend = spy.iloc[spy_idx] > spy200 and spy20mom > 0
        strong_bear = spy.iloc[spy_idx] < spy200 and spy20mom < 0
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
            spy_factor = 1.5 if spy20mom > 0.10 else 0.5 if spy20mom < 0.02 else 1.0
            pos = []
            for idx2, s in enumerate(picks):
                entry = day[s]
                if np.isnan(entry) or entry <= 0: continue
                atr_now = None
                try:
                    ac = atr_cache[s]
                    ai = ac.index.get_indexer([date], method='ffill')[0]
                    atr_now = ac.iloc[ai] if ai >= 0 and ai < len(ac) else None
                except: pass
                atr_v = atr_now or 0.03
                atr_factor = 0.8 if atr_v > 0.04 else 1.2 if atr_v < 0.015 else 1.0
                sl_pct = 0.20 if atr_v > 0.04 else 0.12 if atr_v < 0.015 else 0.15
                w = (0.6 if idx2 == 0 else 0.4) * spy_factor * atr_factor
                pos.append({'sym': s, 'dir': '多' if bull else '空', 'entry': entry,
                            'tp': entry * 1.40 if bull else entry * 0.60,
                            'stop': entry * (1 - sl_pct) if bull else entry * (1 + sl_pct),
                            'be': entry, 'hold': 0, 'trailed': False, 'w': w, 'sl_pct': sl_pct, 'lever': lever})
            if not pos: pos = None
        elif pos:
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                p['hold'] += 1
                lev = p['lever']
                w = p['w']
                funding = FUNDING_DAY * lev * w
                def close_ret(price_ret):
                    return price_ret * lev * w - FEE_TICK * lev * w * 2 - funding * p['hold']
                pnl_pct = (price - p['entry']) / p['entry'] if p['dir'] == '多' else (p['entry'] - price) / p['entry']
                if pnl_pct >= 0.10:
                    p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                if pnl_pct >= 0.20:
                    p['be'] = max(p['be'], p['entry'] * 1.10 if p['dir'] == '多' else p['entry'] * 0.90)
                if p['dir'] == '多':
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        equity *= (1 + ret); continue
                    if price >= p['tp']:
                        ret = close_ret(0.40)
                        equity *= (1 + ret); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = close_ret(-p['sl_pct'])
                            equity *= (1 + ret); continue
                    else:
                        if price <= p['be']:
                            ret = close_ret((price - p['entry']) / p['entry'])
                            equity *= (1 + ret); continue
                else:
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        equity *= (1 + ret); continue
                    if price <= p['tp']:
                        ret = close_ret(0.40)
                        equity *= (1 + ret); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = close_ret(-p['sl_pct'])
                            equity *= (1 + ret); continue
                    else:
                        if price >= p['be']:
                            ret = close_ret((p['entry'] - price) / p['entry'])
                            equity *= (1 + ret); continue
                remaining.append(p)
            pos = remaining or None
    return equity

print('=== 滚仓v8: 动态杠杆 vs 固定5x (含成本) ===')
print('配置 | 2022 | 2023 | 2024 | 2025 | 2026 | 5年均值')
for name, dyn in [('固定5x', False), ('动态杠杆', True)]:
    eqs = []
    line = f'{name:>8} |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq = run_roll(year, dyn)
        eqs.append(eq)
        line += f' {eq:>7.0f} |'
    print(f'{line} {np.mean(eqs):>7.0f}')
