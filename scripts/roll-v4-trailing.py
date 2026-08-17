#!/usr/bin/env python3
"""滚仓v4: 移动止损 + 快速周转
- SPY200过滤, 2标的半仓
- 止损: 初始-15%, 盈利+30%后止损上移保本, +60%后上移+30%
- 止盈: +80% 全平(更快兑现, 提高周转)
- 持仓上限: 10天强制平(不拖)
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

def run_roll(year, tp_pct=0.80, max_hold=10):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None
    equity, trades = 10000, []
    pos = None
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
                            'tp': entry * (1 + tp_pct) if bull else entry * (1 - tp_pct),
                            'stop': entry * 0.85 if bull else entry * 1.15,
                            'be': entry if bull else entry,  # 保本线
                            'hold': 0, 'max_hold': max_hold, 'trailed': False})
            if not pos: pos = None
        elif pos:
            remaining = []
            for p in pos:
                price = day[p['sym']]
                if np.isnan(price): remaining.append(p); continue
                p['hold'] += 1
                weight = 0.5
                if p['dir'] == '多':
                    # 移动止损: +30% 后保本, +60% 后锁+30%
                    if price >= p['entry'] * 1.30:
                        p['be'] = max(p['be'], p['entry'])
                        p['trailed'] = True
                    if price >= p['entry'] * 1.60:
                        p['be'] = max(p['be'], p['entry'] * 1.30)
                    # 强制持仓上限
                    if p['hold'] >= p['max_hold']:
                        ret = (price - p['entry']) / p['entry'] * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', '超时平', ret, equity)); continue
                    # 止盈
                    if price >= p['tp']:
                        ret = tp_pct * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '多', f'止盈{tp_pct*100:.0f}%', ret, equity)); continue
                    # 止损(移动后)
                    if price <= p['be'] * (0.85 if not p['trailed'] else 1.0):
                        if not p['trailed']:
                            ret = -0.15 * LEVER * weight - FEE * LEVER * weight
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '止损-15%', ret, equity)); continue
                        else:
                            ret = (price - p['entry']) / p['entry'] * LEVER * weight - FEE * LEVER * weight
                            equity *= (1 + ret); trades.append((date, p['sym'], '多', '保本走', ret, equity)); continue
                else:
                    if price <= p['entry'] * 0.70:
                        p['be'] = min(p['be'], p['entry']); p['trailed'] = True
                    if price <= p['entry'] * 0.40:
                        p['be'] = min(p['be'], p['entry'] * 0.70)
                    if p['hold'] >= p['max_hold']:
                        ret = (p['entry'] - price) / p['entry'] * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', '超时平', ret, equity)); continue
                    if price <= p['tp']:
                        ret = tp_pct * LEVER * weight - FEE * LEVER * weight
                        equity *= (1 + ret); trades.append((date, p['sym'], '空', f'止盈{tp_pct*100:.0f}%', ret, equity)); continue
                    if price >= p['be'] * (1.15 if not p['trailed'] else 1.0):
                        if not p['trailed']:
                            ret = -0.15 * LEVER * weight - FEE * LEVER * weight
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '止损-15%', ret, equity)); continue
                        else:
                            ret = (p['entry'] - price) / p['entry'] * LEVER * weight - FEE * LEVER * weight
                            equity *= (1 + ret); trades.append((date, p['sym'], '空', '保本走', ret, equity)); continue
                remaining.append(p)
            pos = remaining or None
    return equity, trades

print('=== 滚仓v4 (移动止损 + 止盈80% + 10天上限) ===')
print('年份 | 期末 | 收益率 | 笔数(盈)')
for year in [2022, 2023, 2024, 2025, 2026]:
    r = run_roll(year)
    if not r: print(f'{year}: 数据不足'); continue
    eq, trades = r
    wins = sum(1 for t in trades if t[4] > 0)
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+7.1f}% | {len(trades)}笔({wins}盈)')
