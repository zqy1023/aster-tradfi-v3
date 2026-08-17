#!/usr/bin/env python3
"""SPY方向过滤多空滚仓: 大盘强做多#1, 大盘弱做空#11
分年度验证 2022-2026
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
        if spy_idx < 20: continue
        spy_mom = (spy.iloc[spy_idx] - spy.iloc[spy_idx - 20]) / spy.iloc[spy_idx - 20]
        if pos is None:
            mom = {}
            for s in SYMS:
                cc = c[s].dropna()
                idx = cc.index.get_indexer([date], method='ffill')[0]
                if idx >= 20 and cc.iloc[idx] > 0:
                    mom[s] = (cc.iloc[idx] - cc.iloc[idx - 20]) / cc.iloc[idx - 20]
            if not mom: continue
            if spy_mom > 0:
                best = max(mom, key=mom.get)
                entry = day[best]
                pos = {'sym': best, 'dir': '多', 'entry': entry, 'target': entry * 1.333, 'stop': entry * 0.90}
            else:
                worst = min(mom, key=mom.get)
                entry = day[worst]
                pos = {'sym': worst, 'dir': '空', 'entry': entry, 'target': entry * 0.667, 'stop': entry * 1.10}
        else:
            price = day[pos['sym']]
            if np.isnan(price): continue
            if pos['dir'] == '多':
                if price <= pos['stop']:
                    ret = -0.10 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '多', '止损', ret, equity)); pos = None; continue
                if price >= pos['target']:
                    ret = 0.333 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '多', '翻倍', ret, equity)); pos = None
            else:
                if price >= pos['stop']:
                    ret = -0.10 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '空', '止损', ret, equity)); pos = None; continue
                if price <= pos['target']:
                    ret = 0.333 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '空', '翻倍', ret, equity)); pos = None
    return equity, trades

print('=== SPY方向过滤 多空滚仓 分年度 (3x杠杆, 10%止损, 翻倍滚) ===')
print('年份 | 期末 | 收益率 | 笔数(盈) | 多头/空头')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r:
        print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    longs = sum(1 for t in trades if t[2] == '多')
    shorts = sum(1 for t in trades if t[2] == '空')
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈) | 多{longs}/空{shorts}')

print('\n=== 2022 熊市明细 ===')
r = run_roll(2022)
if r:
    for t in r[1]:
        print(f"  {t[0].strftime('%m-%d')} {t[1]:>7} {t[2]} {t[3]} | {t[4]*100:+.1f}% | {t[5]:,.0f}")
