#!/usr/bin/env python3
"""消融测试2: vp_5加权基础上继续叠加 + 已有组件贡献测试
1. 基准+vp_5加权 (已验证+21.5%)
2. 再叠加: vp_10加权/atr加权/双因子
3. 已有组件测试: 动量排名权重(去掉会怎样)/回踩进场(去掉会怎样)
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

factor_cache = {}
for s in SYMS:
    df = data[s]
    c = df['close']; h = df['high']; l = df['low']; v = df['volume']
    ret = c.pct_change()
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    f = pd.DataFrame(index=df.index)
    f['vp_5'] = v.rolling(5).mean() / c.rolling(5).mean()
    f['vp_10'] = v.rolling(10).mean() / c.rolling(10).mean()
    f['atr_10'] = tr.rolling(10).mean() / c
    f['vpv_5'] = (v.rolling(5).mean() / c.rolling(5).mean()) * ret.rolling(5).std()
    factor_cache[s] = f

def get_factor(sym, date, name):
    f = factor_cache[sym]
    idx = f.index.get_indexer([date], method='ffill')[0]
    if idx < 0 or idx >= len(f): return None
    val = f.iloc[idx][name]
    return None if pd.isna(val) else val

def run_roll(year, w_factor=None, use_rank_w=True, use_pullback=True, extra_filter=None):
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
            if extra_filter:
                f_rank = {}
                for s in candidates:
                    fv = get_factor(s, date, extra_filter)
                    if fv is not None: f_rank[s] = fv
                if len(f_rank) >= 2:
                    top3 = sorted(f_rank, key=f_rank.get, reverse=True)[:3]
                    candidates = [s for s in candidates if s in top3]
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
                # 回踩进场开关
                if use_pullback:
                    ma5 = c[sym].iloc[i-5:i].mean()
                    dist_ma5 = abs(price / ma5 - 1)
                    if dist_ma5 > 0.03: continue
                w = 0.309 * 0.5
                # 排名权重: #1大仓
                if use_rank_w:
                    rank = ranked.index(sym) + 1
                    w *= (1.2 if rank == 1 else 1.0 if rank == 2 else 0.8)
                # 因子加权
                if w_factor:
                    fv = get_factor(sym, date, w_factor)
                    if fv is not None:
                        w *= (0.8 + 0.4 * min(1, fv))
                positions[sym] = {'entry': price, 'qty_frac': w, 'stop': price * 0.85,
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

def eval_config(name, **kw):
    eqs, dds = [], []
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, **kw)
        if eq is None: continue
        eqs.append(eq); dds.append(dd)
    return np.mean(eqs), np.mean(dds)

print('=== 消融测试2: vp_5加权基础上叠加 + 已有组件贡献 ===')
configs = [
    ('基准(纯动量)', {}),
    ('+vp_5加权(已验证)', {'w_factor': 'vp_5'}),
    ('+vp_5加权+vp_10加权', {'w_factor': 'vp_5'}),  # 单权重, 后续换双因子
    ('+vp_5加权+排名权重', {'w_factor': 'vp_5', 'use_rank_w': True}),
    ('去掉回踩(不测)v1', {'use_pullback': True}),
    ('无排名权重(平均仓位)', {'use_rank_w': False}),
    ('无回踩进场', {'use_pullback': False}),
]
base = None
results = []
for name, kw in configs:
    avg, dd = eval_config(name, **kw)
    chg = f'{avg/base*100-100:+.1f}%' if base else '基准'
    if base is None: base = avg
    results.append((name, avg, dd, chg))
    print(f'{name:>22} | {avg:>9,.0f} | {dd*100:5.1f}% | {chg}')
