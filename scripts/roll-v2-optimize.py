#!/usr/bin/env python3
"""滚仓策略 v2 优化:
- 方向: SPY 收盘 > 200日均线 → 只做多; < 200日均线 → 只做空
- 止损: 多 -15% / 空 -15% (收紧)
- 止盈: +50% 平一半, 剩余冲 +100% 翻倍
- 标的: 动量#1(多) / 动量#11(空)
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
        # SPY 200日均线方向
        spy_idx = spy.index.get_indexer([date], method='ffill')[0]
        if spy_idx < 200: continue
        spy200 = spy.iloc[spy_idx - 200:spy_idx].mean()
        bull = spy.iloc[spy_idx] > spy200
        if pos is None:
            mom = {}
            for s in SYMS:
                cc = c[s].dropna()
                idx = cc.index.get_indexer([date], method='ffill')[0]
                if idx >= 20 and cc.iloc[idx] > 0:
                    mom[s] = (cc.iloc[idx] - cc.iloc[idx - 20]) / cc.iloc[idx - 20]
            if not mom: continue
            if bull:
                best = max(mom, key=mom.get)
                entry = day[best]
                pos = {'sym': best, 'dir': '多', 'entry': entry,
                       'tp1': entry * 1.50, 'tp2': entry * 1.333 * 1.5,  # +50% 平半, 翻倍价
                       'stop': entry * 0.85, 'half_done': False}
            else:
                worst = min(mom, key=mom.get)
                entry = day[worst]
                pos = {'sym': worst, 'dir': '空', 'entry': entry,
                       'tp1': entry * 0.50, 'tp2': entry * 0.667 * 0.5,
                       'stop': entry * 1.15, 'half_done': False}
        else:
            price = day[pos['sym']]
            if np.isnan(price): continue
            if pos['dir'] == '多':
                if price <= pos['stop']:
                    ret = -0.15 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '多', '止损-15%', ret, equity)); pos = None; continue
                if not pos['half_done'] and price >= pos['tp1']:
                    # 平一半: 收益 = 50%仓位 × (+50%×3x)
                    ret = 0.5 * 0.50 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '多', '止盈半仓+50%', ret, equity))
                    pos['half_done'] = True
                if pos['half_done'] and price >= pos['tp2']:
                    ret = 0.5 * 1.0 * LEVER - FEE * LEVER  # 剩一半翻倍
                    equity *= (1 + ret); trades.append((date, pos['sym'], '多', '翻倍清仓', ret, equity)); pos = None
            else:
                if price >= pos['stop']:
                    ret = -0.15 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '空', '止损-15%', ret, equity)); pos = None; continue
                if not pos['half_done'] and price <= pos['tp1']:
                    ret = 0.5 * 0.50 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '空', '止盈半仓+50%', ret, equity))
                    pos['half_done'] = True
                if pos['half_done'] and price <= pos['tp2']:
                    ret = 0.5 * 1.0 * LEVER - FEE * LEVER
                    equity *= (1 + ret); trades.append((date, pos['sym'], '空', '翻倍清仓', ret, equity)); pos = None
    return equity, trades

print('=== 滚仓v2 (SPY200日线过滤, 止损15%, 半仓止盈+翻倍) ===')
print('年份 | 期末 | 收益率 | 笔数(盈) | 多/空')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r:
        print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    longs = sum(1 for t in trades if t[2] == '多')
    shorts = sum(1 for t in trades if t[2] == '空')
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈) | 多{longs}/空{shorts}')
