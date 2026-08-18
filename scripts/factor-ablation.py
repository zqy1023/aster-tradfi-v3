#!/usr/bin/env python3
"""因子消融测试: 从基准逐步加因子, 看边际贡献
基准: 动量#1-#4 + 回踩进场 + 分批 + 趋势过滤 (v10)
消融: 每次加1个因子(选股条件/权重), 对比5年结果
标准: 加因子后 5年均值提升 且 回撤不恶化 → 保留
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

# 预计算因子(每标的)
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
    f['vol_10'] = ret.rolling(10).std()
    f['vol_20'] = ret.rolling(20).std()
    f['skew_20'] = ret.rolling(20).skew()
    f['range_7'] = ((h - l) / c).rolling(7).mean()
    factor_cache[s] = f

def get_factor(sym, date, name):
    f = factor_cache[sym]
    idx = f.index.get_indexer([date], method='ffill')[0]
    if idx < 0 or idx >= len(f): return None
    val = f.iloc[idx][name]
    return None if pd.isna(val) else val

def run_roll(year, extra_factor=None, extra_w=None):
    """extra_factor: 选股时额外要求(因子排名前3)
       extra_w: 用因子给仓位加权"""
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
            # 因子过滤: 只保留因子排名前3的候选
            if extra_factor:
                f_rank = {}
                for s in candidates:
                    fv = get_factor(s, date, extra_factor)
                    if fv is not None:
                        f_rank[s] = fv
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
                ma5 = c[sym].iloc[i-5:i].mean()
                dist_ma5 = abs(price / ma5 - 1)
                if dist_ma5 > 0.03: continue
                w = 0.309 * 0.5
                # 因子加权: 因子值高的仓位大
                if extra_w:
                    fv = get_factor(sym, date, extra_w)
                    if fv is not None:
                        w = 0.309 * 0.5 * (0.8 + 0.4 * min(1, fv))  # 权重0.8-1.2x
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

def eval_config(name, extra_factor=None, extra_w=None):
    eqs, dds = [], []
    for year in [2022, 2023, 2024, 2025, 2026]:
        eq, dd = run_roll(year, extra_factor, extra_w)
        if eq is None: continue
        eqs.append(eq); dds.append(dd)
    return np.mean(eqs), np.mean(dds), eqs

print('=== 因子消融测试 (基准=动量v10, 每次加1因子) ===')
print(f'{"配置":>18} | {"5年均值":>9} | {"回撤":>6} | 变化')
configs = [
    ('基准(纯动量)', None, None),
    ('+vp_5过滤', 'vp_5', None),
    ('+vp_5加权', None, 'vp_5'),
    ('+atr_10过滤', 'atr_10', None),
    ('+atr_10加权', None, 'atr_10'),
    ('+vol_10过滤', 'vol_10', None),
    ('+vol_20加权', None, 'vol_20'),
    ('+skew_20过滤', 'skew_20', None),
    ('+range_7过滤', 'range_7', None),
]
base = None
for name, f, w in configs:
    avg, dd, eqs = eval_config(name, f, w)
    chg = f'{avg/base*100-100:+.1f}%' if base else '基准'
    if base is None: base = avg
    print(f'{name:>18} | {avg:>9,.0f} | {dd*100:5.1f}% | {chg}')
