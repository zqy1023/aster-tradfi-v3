#!/usr/bin/env python3
"""v14: 止损收紧优化 - 找收益/回撤最优平衡"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE_TICK = 0.0015
FUNDING_DAY = 0.0003
LEVER = 5
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(path):
    df = pq.read_table(path).to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet') for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d['close'] for s, d in data.items()}).ffill()

factor_cache = {}
for s in SYMS:
    df = data[s]
    c = df['close']; v = df['volume']
    f = pd.DataFrame(index=df.index)
    f['vp_5'] = v.rolling(5).mean() / c.rolling(5).mean()
    factor_cache[s] = f

def get_factor(sym, date, name):
    f = factor_cache[sym]
    idx = f.index.get_indexer([date], method='ffill')[0]
    if idx < 0 or idx >= len(f): return None
    val = f.iloc[idx][name]
    return None if pd.isna(val) else val

def run_roll(year, sl_pct, tp_pct):
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
                        ret = (price - p['entry']) / p['entry'] * LEVER * p['qty_frac'] - FEE_TICK * LEVER * p['qty_frac'] * 2
                        equity *= (1 + ret)
            last_pick = i
            for sym in candidates:
                if sym in positions: continue
                price = day[sym]
                if np.isnan(price) or price <= 0: continue
                w = 0.309 * 0.5
                fv = get_factor(sym, date, 'vp_5')
                if fv is not None:
                    w *= (0.8 + 0.4 * min(1, fv))
                positions[sym] = {'entry': price, 'qty_frac': w, 'stop': price * (1 - sl_pct),
                                  'be': price, 'hold': 0, 'trailed': False, 'added': False}
        for sym in list(positions.keys()):
            p = positions[sym]
            price = day[sym]
            if np.isnan(price): continue
            p['hold'] += 1
            fund = FUNDING_DAY * LEVER * p['qty_frac']
            def cr(pr): return pr * LEVER * p['qty_frac'] - FEE_TICK * LEVER * p['qty_frac'] * 2 - fund * p['hold']
            pnl = (price - p['entry']) / p['entry']
            if pnl >= 0.10: p['be'] = max(p['be'], p['entry']); p['trailed'] = True
            if pnl >= 0.20: p['be'] = max(p['be'], p['entry'] * 1.10)
            if not p['added'] and pnl <= -0.03:
                add_w = p['qty_frac'] * 0.6
                p['qty_frac'] += add_w
                p['entry'] = (p['entry'] * (p['qty_frac'] - add_w) + price * add_w) / p['qty_frac']
                p['added'] = True
            if price >= p['entry'] * (1 + tp_pct):
                ret = cr(tp_pct)
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
                    ret = cr(-sl_pct)
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

print('=== v14: 止损/止盈参数优化 (去回踩+vp_5加权) ===')
print(f'{"止损/止盈":>12} | {"5年均值":>9} | {"回撤":>6}')
for sl, tp in [(0.15, 0.40), (0.12, 0.40), (0.10, 0.40), (0.12, 0.60), (0.15, 0.60), (0.10, 0.60)]:
    eqs, dds = [], []
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, sl, tp)
        if eq is None: continue
        eqs.append(eq); dds.append(dd)
    print(f'{sl*100:.0f}%/{tp*100:.0f}% | {np.mean(eqs):>9,.0f} | {np.mean(dds)*100:5.1f}%')
