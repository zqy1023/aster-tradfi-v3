#!/usr/bin/env python3
"""滚仓v5 真实成本版: 手续费 + 滑点 + 资金费
成本模型:
- 手续费: taker 0.05% × 2 (开+平) = 0.10%
- 滑点: 0.10% (每边0.05%, 3x ETF 流动性)
- 资金费: 0.01%/8h = 0.03%/天 (永续持仓成本, 平均)
每笔总成本 ≈ 开0.15% + 平0.15% + 持仓天数×0.03%
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

LEVER = 3
FEE_TICK = 0.0015   # 每边 手续费0.05%+滑点0.05%+缓冲 = 0.15%
FUNDING_DAY = 0.0003  # 资金费 0.03%/天
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
                # 资金费: 持仓每天扣
                funding = FUNDING_DAY * LEVER * w
                # 完整成本: 平仓时 开仓FEE_TICK + 平仓FEE_TICK + 持仓资金费
                def close_ret(price_ret):
                    # 价格收益×杠杆 - 双边成本 - 资金费
                    return price_ret * LEVER * w - FEE_TICK * LEVER * w * 2 - funding * p['hold']
                if p['dir'] == '多':
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                    if price >= p['entry'] * 1.60:
                        p['be'] = max(p['be'], p['entry'] * 1.30)
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '超时', ret, equity)); continue
                    if price >= p['tp']:
                        ret = close_ret(0.80)
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '止盈', ret, equity)); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '止损', ret, equity)); continue
                    else:
                        if price <= p['be']:
                            ret = close_ret((price - p['entry']) / p['entry'])
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '保本', ret, equity)); continue
                else:
                    if price <= p['entry'] * 0.70:
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * 0.40:
                        p['be'] = min(p['be'], p['entry'] * 0.70)
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '超时', ret, equity)); continue
                    if price <= p['tp']:
                        ret = close_ret(0.80)
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '止盈', ret, equity)); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = close_ret(-0.15)
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '止损', ret, equity)); continue
                    else:
                        if price >= p['be']:
                            ret = close_ret((p['entry'] - price) / p['entry'])
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '保本', ret, equity)); continue
                remaining.append(p)
            pos = remaining or None
    return equity, trades

print('=== 滚仓v5 真实成本版 (手续费0.1%+滑点0.2%+资金费0.03%/天) ===')
print('年份 | 期末 | 收益率 | 笔数(盈)')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r: print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈)')
