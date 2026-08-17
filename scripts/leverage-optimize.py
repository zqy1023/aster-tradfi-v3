#!/usr/bin/env python3
"""杠杆优化: 3x vs 5x vs 10x, 收益速度与爆仓风险
含成本(手续费+滑点+资金费), 止盈40%止损15%, SPY趋势过滤
关键: 杠杆越高, 15%价格止损=更大权益亏损; 需算爆仓风险
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

def run_roll(year, lever, tp_pct=0.40):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None, None
    equity = 10000
    max_dd = 0
    peak = 10000
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
                funding = FUNDING_DAY * lever * w
                def close_ret(price_ret):
                    return price_ret * lever * w - FEE_TICK * lever * w * 2 - funding * p['hold']
                if p['dir'] == '多':
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if price >= p['entry'] * 1.60:
                        p['be'] = max(p['be'], p['entry'] * 1.30)
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
                    if price <= p['entry'] * 0.70:
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * 0.40:
                        p['be'] = min(p['be'], p['entry'] * 0.70)
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
        peak = max(peak, equity)
        max_dd = min(max_dd, equity / peak - 1)
    return equity, max_dd

print('=== 杠杆优化 (止盈40%止损15%, 含成本) ===')
print('杠杆 | 2022 | 2023 | 2024 | 2025 | 2026 | 5年均值 | 最大回撤(avg)')
for lever in [3, 5, 10, 15]:
    eqs, dds = [], []
    line = f' {lever:>2}x |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, lever)
        if eq is None:
            line += '  -- |'
            continue
        eqs.append(eq); dds.append(dd)
        line += f' {eq:>6.0f} |'
    avg_eq = np.mean(eqs) if eqs else 0
    avg_dd = np.mean(dds) if dds else 0
    print(f'{line} {avg_eq:>6.0f} | {avg_dd*100:>5.1f}%')

print('\n=== 风险说明 ===')
print('杠杆5x: 15%价格止损 = 权益-75%(半仓) → 单笔可亏37.5%权益')
print('杠杆10x: 15%价格止损 = 权益-150%(半仓) → 单笔可亏75%权益, 接近爆仓')
print('杠杆15x: 15%价格止损 = 权益-225% → 直接爆仓!')
