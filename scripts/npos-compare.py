#!/usr/bin/env python3
"""单标的 vs 双标的对比 (滚仓v5参数, 5x, 含成本)
- 单标的: 100%权益名义压动量#1
- 双标的: 各50%权益名义(#1+#2)
- 三标的: 各33%(#1+#2+#3)
- 四标的: 各25%(#1-#4)
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

def run_roll(year, n_pos, weights=None):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None, None
    equity = 10000
    peak = 10000
    max_dd = 0
    pos = None
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        spy_idx = spy.index.get_indexer([date], method='ffill')[0]
        if spy_idx < 200: continue
        spy200 = spy.iloc[spy_idx - 200:spy_idx].mean()
        spy20mom = (spy.iloc[spy_idx] - spy.iloc[spy_idx - 20]) / spy.iloc[spy_idx - 20]
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
            if len(mom) < n_pos: continue
            ranked = sorted(mom, key=mom.get, reverse=True)
            picks = ranked[:n_pos] if bull else ranked[-n_pos:]
            pos = []
            for idx2, s in enumerate(picks):
                entry = day[s]
                if np.isnan(entry) or entry <= 0: continue
                w = weights[idx2] if weights else (1.0 / n_pos)
                pos.append({'sym': s, 'dir': '多' if bull else '空', 'entry': entry,
                            'tp': entry * 1.40 if bull else entry * 0.60,
                            'stop': entry * 0.85 if bull else entry * 1.15,
                            'be': entry, 'hold': 0, 'trailed': False, 'w': w})
            if not pos: pos = None
        elif pos:
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                p['hold'] += 1
                w = p['w']
                funding = FUNDING_DAY * LEVER * w
                def close_ret(price_ret):
                    return price_ret * LEVER * w - FEE_TICK * LEVER * w * 2 - funding * p['hold']
                pnl_pct = (price - p['entry']) / p['entry'] if p['dir'] == '多' else (p['entry'] - price) / p['entry']
                if pnl_pct >= 0.10:
                    p['be'] = max(p['be'], p['entry']); p['trailed'] = True
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
        peak = max(peak, equity)
        max_dd = min(max_dd, equity / peak - 1)
    return equity, max_dd

configs = [
    ('单标的100%', 1, None),
    ('双标的50/50', 2, None),
    ('三标的33/33/33', 3, None),
    ('四标的25×4', 4, None),
    ('双标的60/40', 2, [0.6, 0.4]),
]

print('=== 单标的 vs 双标的 vs 更多 (5x, 含成本) ===')
print('配置 | 2022 | 2023 | 2024 | 2025 | 2026 | 5年均值 | 平均回撤')
for name, n, w in configs:
    eqs, dds = [], []
    line = f'{name:>12} |'
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, n, w)
        if eq is None:
            line += '  -- |'
            continue
        eqs.append(eq); dds.append(dd)
        line += f' {eq:>7.0f} |'
    avg_eq = np.mean(eqs) if eqs else 0
    avg_dd = np.mean(dds) if dds else 0
    print(f'{line} {avg_eq:>7.0f} | {avg_dd*100:>5.1f}%')
