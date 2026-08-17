#!/usr/bin/env python3
"""滚仓v6: 动态止损 + 补仓机制
- 动态止损: +10%保本/+20%锁10%/+30%锁20% (利润越高止损越紧)
- 补仓: 浮盈+15%加仓30%, 浮盈+30%再加30% (盈利滚大)
- 基准: 5x, 止盈40%, SPY趋势过滤, 含成本
"""
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

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet')['close'] for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d for s, d in data.items()}).ffill()

def run_roll(year, use_dyn_sl=True, use_add=True):
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
                            'tp': entry * 1.40 if bull else entry * 0.60,
                            'stop': entry * 0.85 if bull else entry * 1.15,
                            'be': entry, 'hold': 0, 'trailed': False,
                            'added': False, 'added2': False, 'mult': 1.0})
            if not pos: pos = None
        elif pos:
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                p['hold'] += 1
                w = 0.5 * p['mult']  # 仓位倍数(补仓后增大)
                funding = FUNDING_DAY * LEVER * w
                def close_ret(price_ret):
                    return price_ret * LEVER * w - FEE_TICK * LEVER * w * 2 - funding * p['hold']
                # 动态止损: 盈利上移
                pnl_pct = (price - p['entry']) / p['entry'] if p['dir'] == '多' else (p['entry'] - price) / p['entry']
                if use_dyn_sl:
                    if pnl_pct >= 0.10:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if pnl_pct >= 0.20:
                        p['be'] = max(p['be'], p['entry'] * 1.10 if p['dir'] == '多' else p['entry'] * 0.90)
                    if pnl_pct >= 0.30:
                        p['be'] = max(p['be'], p['entry'] * 1.20 if p['dir'] == '多' else p['entry'] * 0.80)
                else:
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                # 补仓: 浮盈+15% 加30%, +30% 再加30%
                if use_add:
                    if pnl_pct >= 0.15 and not p['added']:
                        p['added'] = True
                        p['mult'] = 1.3
                    if pnl_pct >= 0.30 and not p['added2']:
                        p['added2'] = True
                        p['mult'] = 1.6
                if p['dir'] == '多':
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        equity *= (1 + ret); continue
                    if price >= p['tp']:
                        ret = close_ret(0.40)
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
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        equity *= (1 + ret); continue
                    if price <= p['tp']:
                        ret = close_ret(0.40)
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

print('=== 滚仓v6: 动态止损+补仓 对比 (5x, 含成本) ===')
configs = [('基准(固定止损无补仓)', False, False), ('动态止损', True, False), ('补仓', False, True), ('v6(动态止损+补仓)', True, True)]
for name, dyn, add in configs:
    eqs = []
    line = f'{name:>16} |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq = run_roll(year, dyn, add)
        eqs.append(eq)
        line += f' {eq:>7.0f} |'
    print(f'{line} {np.mean(eqs):>7.0f}')
