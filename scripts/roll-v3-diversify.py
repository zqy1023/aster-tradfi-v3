#!/usr/bin/env python3
"""滚仓v3: SPY200过滤 + 2标的半仓分散(动量#1+#2) + 止损15% + 半仓止盈翻倍"""
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

def run_roll(year):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None
    equity, trades = 10000, []
    pos = None  # 两个标的各50%
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
                            'tp1': entry * 1.50 if bull else entry * 0.50,
                            'tp2': entry * 1.333 * 1.5 if bull else entry * 0.667 * 0.5,
                            'stop': entry * 0.85 if bull else entry * 1.15,
                            'half_done': False})
            if not pos: pos = None
        elif pos:
            # 检查两个持仓
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                weight = 0.5  # 每仓半仓
                if p['dir'] == '多':
                    if price <= p['stop']:
                        ret = -0.15 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '止损-15%', ret, equity)); continue
                    if not p['half_done'] and price >= p['tp1']:
                        ret = 0.5 * 0.50 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '止盈半+50%', ret, equity)); p['half_done'] = True
                    if p['half_done'] and price >= p['tp2']:
                        ret = 0.5 * 1.0 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '翻倍清', ret, equity)); continue
                else:
                    if price >= p['stop']:
                        ret = -0.15 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '止损-15%', ret, equity)); continue
                    if not p['half_done'] and price <= p['tp1']:
                        ret = 0.5 * 0.50 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '止盈半+50%', ret, equity)); p['half_done'] = True
                    if p['half_done'] and price <= p['tp2']:
                        ret = 0.5 * 1.0 * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '翻倍清', ret, equity)); continue
                remaining.append(p)
            pos = remaining or None
    return equity, trades

print('=== 滚仓v3 (2标的各半仓, SPY200过滤, 止损15%, 半仓止盈) ===')
print('年份 | 期末 | 收益率 | 笔数(盈)')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r:
        print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈)')
