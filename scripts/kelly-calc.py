#!/usr/bin/env python3
"""凯利公式接入: 用回测真实胜率/盈亏比算最优仓位
凯利 f* = (bp - q) / b
  b = 盈亏比(平均盈利/平均亏损)
  p = 胜率
  q = 1-p
半凯利(保守) = f*/2 —— 实盘常用, 避免过拟合风险
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

def run_roll(year):
    """返回每笔交易的收益率列表(用于算胜率/盈亏比)"""
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return []
    trade_rets = []
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
            if len(mom) < 2: continue
            ranked = sorted(mom, key=mom.get, reverse=True)
            picks = ranked[:2] if bull else ranked[-2:]
            pos = []
            for s in picks:
                entry = day[s]
                if np.isnan(entry) or entry <= 0: continue
                pos.append({'sym': s, 'dir': '多' if bull else '空', 'entry': entry,
                            'tp': entry * 1.40 if bull else entry * 0.60,
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
                funding = FUNDING_DAY * LEVER * w
                def close_ret(price_ret):
                    return price_ret * LEVER * w - FEE_TICK * LEVER * w * 2 - funding * p['hold']
                pnl_pct = (price - p['entry']) / p['entry'] if p['dir'] == '多' else (p['entry'] - price) / p['entry']
                if pnl_pct >= 0.10:
                    p['be'] = max(p['be'], p['entry']); p['trailed'] = True
                if p['dir'] == '多':
                    if p['hold'] >= 10:
                        ret = close_ret((price - p['entry']) / p['entry'])
                        trade_rets.append(ret); continue
                    if price >= p['tp']:
                        ret = close_ret(0.40)
                        trade_rets.append(ret); continue
                    if not p['trailed']:
                        if price <= p['stop']:
                            ret = close_ret(-0.15)
                            trade_rets.append(ret); continue
                    else:
                        if price <= p['be']:
                            ret = close_ret((price - p['entry']) / p['entry'])
                            trade_rets.append(ret); continue
                else:
                    if p['hold'] >= 10:
                        ret = close_ret((p['entry'] - price) / p['entry'])
                        trade_rets.append(ret); continue
                    if price <= p['tp']:
                        ret = close_ret(0.40)
                        trade_rets.append(ret); continue
                    if not p['trailed']:
                        if price >= p['stop']:
                            ret = close_ret(-0.15)
                            trade_rets.append(ret); continue
                    else:
                        if price >= p['be']:
                            ret = close_ret((p['entry'] - price) / p['entry'])
                            trade_rets.append(ret); continue
                remaining.append(p)
            pos = remaining or None
    return trade_rets

# 收集全部交易
all_rets = []
for year in [2022, 2023, 2024, 2025, 2026]:
    all_rets.extend(run_roll(year))

rets = np.array(all_rets)
wins = rets[rets > 0]
losses = rets[rets < 0]
p = len(wins) / len(rets)
avg_win = wins.mean() if len(wins) else 0
avg_loss = abs(losses.mean()) if len(losses) else 0
b = avg_win / avg_loss if avg_loss else 0
q = 1 - p

# 凯利
f_full = (b * p - q) / b if b else 0
f_half = f_full / 2
f_quarter = f_full / 4

print(f'=== 凯利公式计算 (5年 {len(rets)} 笔交易) ===')
print(f'胜率 p: {p*100:.1f}%')
print(f'平均盈利: {avg_win*100:+.2f}% | 平均亏损: {avg_loss*100:.2f}%')
print(f'盈亏比 b: {b:.2f}')
print(f'\n凯利 f*: {f_full*100:.1f}% (最优下注比例)')
print(f'半凯利: {f_half*100:.1f}% (实盘推荐, 防过拟合)')
print(f'四分之一凯利: {f_quarter*100:.1f}% (最保守)')

# 对比当前仓位
print(f'\n=== 与当前策略对比 ===')
print(f'当前: 单标的名义50%权益, 5x杠杆 → 单笔风险敞口 = 50%×5 = 250%权益名义')
print(f'凯利建议: 单笔下注 {f_half*100:.1f}% (半凯利)')
print(f'\n结论:')
if f_half < 0.5:
    print(f'  半凯利 {f_half*100:.1f}% < 当前50%仓位 → 当前仓位过大, 应降')
else:
    print(f'  半凯利 {f_half*100:.1f}% >= 当前50% → 仓位合理或可加')
