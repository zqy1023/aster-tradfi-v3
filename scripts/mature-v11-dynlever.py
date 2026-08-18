#!/usr/bin/env python3
"""成熟策略 v11: v10 + 动态杠杆
- 回踩进场+分批+趋势过滤(保持v10防回调)
- 动态杠杆: SPY 20日动量>10%→8x, 2-10%→6x, <2%→4x
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

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet') for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d['close'] for s, d in data.items()}).ffill()

def dyn_lever(spy20):
    if spy20 > 0.10: return 8
    if spy20 > 0.02: return 6
    return 4

def run_roll(year, use_dyn=True):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None, None
    equity = 10000
    peak = 10000
    max_dd = 0
    positions = {}
    last_pick = -999
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        si = spy.index.get_indexer([date], method='ffill')[0]
        if si < 200: continue
        s200 = spy.iloc[si-200:si].mean()
        s20 = (spy.iloc[si] - spy.iloc[si-20]) / spy.iloc[si-20]
        bull = spy.iloc[si] > s200 and s20 > 0
        lever = dyn_lever(s20) if use_dyn else 5
        if not bull:
            positions = {}
            continue
        if i - last_pick >= 5:
            mom = {}
            for s in SYMS:
                cc = c[s].dropna()
                idx = cc.index.get_indexer([date], method='ffill')[0]
                if idx >= 20 and cc.iloc[idx] > 0:
                    mom[s] = (cc.iloc[idx] - cc.iloc[idx-20]) / cc.iloc[idx-20]
            ranked = sorted(mom, key=mom.get, reverse=True)
            candidates = ranked[:4]
            for sym in list(positions.keys()):
                if sym not in candidates:
                    p = positions.pop(sym)
                    price = day[sym]
                    if not np.isnan(price):
                        ret = (price - p['entry']) / p['entry'] * p['lever'] * p['qty_frac'] - FEE_TICK * p['lever'] * p['qty_frac'] * 2
                        equity *= (1 + ret)
            last_pick = i
            for sym in candidates:
                if sym in positions: continue
                price = day[sym]
                if np.isnan(price) or price <= 0: continue
                ma5 = c[sym].iloc[i-5:i].mean()
                dist_ma5 = abs(price / ma5 - 1)
                if dist_ma5 > 0.03: continue
                w = 0.309 * 0.5
                positions[sym] = {'entry': price, 'qty_frac': w, 'stop': price * 0.85,
                                  'be': price, 'hold': 0, 'trailed': False, 'added': False, 'lever': lever}
        for sym in list(positions.keys()):
            p = positions[sym]
            price = day[sym]
            if np.isnan(price): continue
            p['hold'] += 1
            fund = FUNDING_DAY * p['lever'] * p['qty_frac']
            def cr(pr): return pr * p['lever'] * p['qty_frac'] - FEE_TICK * p['lever'] * p['qty_frac'] * 2 - fund * p['hold']
            pnl = (price - p['entry']) / p['entry']
            if pnl >= 0.10: p['be'] = max(p['be'], p['entry']); p['trailed'] = True
            if pnl >= 0.20: p['be'] = max(p['be'], p['entry'] * 1.10)
            if not p['added'] and pnl <= -0.03:
                add_w = p['qty_frac'] * 0.6
                p['qty_frac'] += add_w
                p['entry'] = (p['entry'] * (p['qty_frac'] - add_w) + price * add_w) / p['qty_frac']
                p['added'] = True
            if price >= p['entry'] * 1.40:
                ret = cr(0.40)
                equity *= (1 + ret)
                positions.pop(sym)
                continue
            if p['hold'] >= 10:
                ret = cr((price - p['entry']) / p['entry'])
                equity *= (1 + ret)
                positions.pop(sym)
                continue
            if not p['trailed']:
                if price <= p['stop']:
                    ret = cr(-0.15)
                    equity *= (1 + ret)
                    positions.pop(sym)
                    continue
            else:
                if price <= p['be']:
                    ret = cr((price - p['entry']) / p['entry'])
                    equity *= (1 + ret)
                    positions.pop(sym)
                    continue
        peak = max(peak, equity)
        max_dd = min(max_dd, equity / peak - 1)
    return equity, max_dd

print('=== v11 动态杠杆 vs v10 固定5x ===')
for name, dyn in [('v10固定5x', False), ('v11动态杠杆', True)]:
    eqs, dds = [], []
    line = f'{name:>10} |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, dyn)
        if eq is None:
            line += '  -- |'
            continue
        eqs.append(eq); dds.append(dd)
        line += f' {eq:>7,.0f} |'
    print(f'{line} 均值{np.mean(eqs):>7,.0f} | 回撤{np.mean(dds)*100:.1f}%')
