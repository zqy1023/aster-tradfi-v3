#!/usr/bin/env python3
"""滚仓v5: v4 + 趋势强度过滤
交易条件: SPY收盘>200日线 AND SPY 20日动量>0 (强趋势才交易)
震荡/回调(20日动量<0) → 空仓等待
其余规则同v4: 2标的半仓, 移动止损, 止盈80%, 10天上限
"""
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
    pos = None
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        spy_idx = spy.index.get_indexer([date], method='ffill')[0]
        if spy_idx < 200: continue
        spy200 = spy.iloc[spy_idx - 200:spy_idx].mean()
        spy20 = (spy.iloc[spy_idx] - spy.iloc[spy_idx - 20]) / spy.iloc[spy_idx - 20]
        # 趋势过滤: 200日线上 + 20日动量>0 → 多头趋势市
        strong_trend = spy.iloc[spy_idx] > spy200 and spy20 > 0
        # 200日线下 + 20日动量<0 → 空头趋势市(做空)
        strong_bear = spy.iloc[spy_idx] < spy200 and spy20 < 0
        if not (strong_trend or strong_bear):
            pos = None  # 震荡市强制空仓
            continue
        bull = strong_trend  # 强趋势做多; 强熊做空
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
                            'tp': entry * 1.80 if bull else entry * 0.20,
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
                if p['dir'] == '多':
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if price >= p['entry'] * 1.60:
                        p['be'] = max(p['be'], p['entry'] * 1.30)
                    if p['hold'] >= 10:
                        ret = (price - p['entry']) / p['entry'] * LEVER * w - FEE * LEVER * w
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '超时', ret, equity)); continue
                    if price >= p['tp']:
                        ret = 0.80 * LEVER * w - FEE * LEVER * w
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '止盈', ret, equity)); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = -0.15 * LEVER * w - FEE * LEVER * w
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '止损', ret, equity)); continue
                    else:
                        if price <= p['be']:
                            ret = (price - p['entry']) / p['entry'] * LEVER * w - FEE * LEVER * w
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '保本', ret, equity)); continue
                else:
                    if price <= p['entry'] * 0.70:
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * 0.40:
                        p['be'] = min(p['be'], p['entry'] * 0.70)
                    if p['hold'] >= 10:
                        ret = (p['entry'] - price) / p['entry'] * LEVER * w - FEE * LEVER * w
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '超时', ret, equity)); continue
                    if price <= p['tp']:
                        ret = 0.80 * LEVER * w - FEE * LEVER * w
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '止盈', ret, equity)); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = -0.15 * LEVER * w - FEE * LEVER * w
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '止损', ret, equity)); continue
                    else:
                        if price >= p['be']:
                            ret = (p['entry'] - price) / p['entry'] * LEVER * w - FEE * LEVER * w
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '保本', ret, equity)); continue
                remaining.append(p)
            pos = remaining or None
    return equity, trades

print('=== 滚仓v5 (趋势过滤: SPY200线+20日动量同向才交易) ===')
print('年份 | 期末 | 收益率 | 笔数(盈)')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r: print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈)')
