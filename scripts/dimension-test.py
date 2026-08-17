#!/usr/bin/env python3
"""逐维度测试: 在凯利4标×30.9%基础上, 每次加一个维度
维度1: 成交量确认(动量+近5日放量>均值1.2x)
维度2: 回撤位置(动量强且距20日高点回撤<15%)
维度3: 波动过滤(ATR>5%降权)
维度4: 相对强度(跑赢SPY才算)
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

data = {s: load(f'/opt/aster-equity/data/import/cash_equity_daily/{s}-USDT-SWAP.parquet') for s in SYMS}
spy = load('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet')['close']
closes = pd.DataFrame({s: d['close'] for s, d in data.items()}).ffill()
vols = pd.DataFrame({s: d['volume'] for s, d in data.items()}).ffill()

def run_roll(year, use_vol=False, use_dd=False, use_atr=False, use_rel=False, w_per=0.309, n_pos=4):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None, None
    equity, peak, max_dd = 10000, 10000, 0
    pos = None
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        si = spy.index.get_indexer([date], method='ffill')[0]
        if si < 200: continue
        s200 = spy.iloc[si-200:si].mean()
        s20 = (spy.iloc[si] - spy.iloc[si-20]) / spy.iloc[si-20]
        bull = spy.iloc[si] > s200 and s20 > 0
        bear = spy.iloc[si] < s200 and s20 < 0
        if not (bull or bear): pos = None; continue
        if pos is None:
            mom = {}
            for s in SYMS:
                cc = c[s].dropna()
                idx = cc.index.get_indexer([date], method='ffill')[0]
                if idx >= 20 and cc.iloc[idx] > 0:
                    m = (cc.iloc[idx] - cc.iloc[idx-20]) / cc.iloc[idx-20]
                    # 维度1: 成交量确认(近5日均量 > 20日均量×1.2)
                    if use_vol:
                        vc = vols[s].dropna()
                        vi = vc.index.get_indexer([date], method='ffill')[0]
                        if vi >= 20:
                            v5 = vc.iloc[vi-5:vi].mean()
                            v20 = vc.iloc[vi-20:vi].mean()
                            if v20 <= 0 or v5 < v20 * 1.2: continue  # 不放量不选
                    # 维度2: 回撤位置(距20日高点回撤<15%)
                    if use_dd:
                        hh = cc.iloc[idx-20:idx].max()
                        if hh > 0 and (cc.iloc[idx] / hh - 1) < -0.15: continue
                    # 维度4: 相对强度(跑赢SPY)
                    if use_rel:
                        sm = (spy.iloc[si] - spy.iloc[si-20]) / spy.iloc[si-20]
                        if m < sm: continue
                    mom[s] = m
            if len(mom) < n_pos: continue
            ranked = sorted(mom, key=mom.get, reverse=True)
            picks = ranked[:n_pos] if bull else ranked[-n_pos:]
            pos = []
            for s in picks:
                entry = day[s]
                if np.isnan(entry) or entry <= 0: continue
                # 维度3: ATR高降权
                w = w_per
                if use_atr:
                    cc = c[s].dropna()
                    tr = pd.concat([cc.diff(), cc - cc.rolling(2).max().shift(), cc.rolling(2).min().shift() - cc], axis=1).max(axis=1)
                    atr20 = (tr.rolling(20).mean() / cc).dropna()
                    ai = atr20.index.get_indexer([date], method='ffill')[0]
                    av = atr20.iloc[ai] if 0 <= ai < len(atr20) else 0.03
                    if av > 0.05: w = w_per * 0.5  # 高波动降半仓
                pos.append({'sym': s, 'dir': '多' if bull else '空', 'entry': entry,
                            'tp': entry*1.4 if bull else entry*0.6,
                            'stop': entry*0.85 if bull else entry*1.15,
                            'be': entry, 'hold': 0, 'trailed': False, 'w': w})
            if not pos: pos = None
        elif pos:
            rem = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): rem.append(p); continue
                p['hold'] += 1
                w = p['w']
                fund = FUNDING_DAY * LEVER * w
                def cr(pr): return pr * LEVER * w - FEE_TICK * LEVER * w * 2 - fund * p['hold']
                pnl = (price - p['entry']) / p['entry'] if p['dir'] == '多' else (p['entry'] - price) / p['entry']
                if pnl >= 0.10: p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                if p['dir'] == '多':
                    if p['hold'] >= 10: equity *= (1+cr((price-p['entry'])/p['entry'])); continue
                    if price >= p['tp']: equity *= (1+cr(0.40)); continue
                    if not p['trailed']:
                        if price <= p['stop']: equity *= (1+cr(-0.15)); continue
                    else:
                        if price <= p['be']: equity *= (1+cr((price-p['entry'])/p['entry'])); continue
                else:
                    if p['hold'] >= 10: equity *= (1+cr((p['entry']-price)/p['entry'])); continue
                    if price <= p['tp']: equity *= (1+cr(0.40)); continue
                    if not p['trailed']:
                        if price >= p['stop']: equity *= (1+cr(-0.15)); continue
                    else:
                        if price >= p['be']: equity *= (1+cr((p['entry']-price)/p['entry'])); continue
                rem.append(p)
            pos = rem or None
        peak = max(peak, equity)
        max_dd = min(max_dd, equity/peak-1)
    return equity, max_dd

print('=== 逐维度测试 (基准: 凯利4标×30.9%) ===')
configs = [
    ('基准(纯动量)', False, False, False, False),
    ('+成交量确认', True, False, False, False),
    ('+回撤位置', False, True, False, False),
    ('+波动降权', False, False, True, False),
    ('+相对强度', False, False, False, True),
]
for name, v1, v2, v3, v4 in configs:
    eqs, dds = [], []
    line = f'{name:>12} |'
    for y in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(y, v1, v2, v3, v4)
        if eq is None: line += '  -- |'; continue
        eqs.append(eq); dds.append(dd)
        line += f' {eq:>7.0f} |'
    print(f'{line} {np.mean(eqs):>7.0f} | {np.mean(dds)*100:>5.1f}%')
