#!/usr/bin/env python3
"""成熟策略 v10: 动量选股 + 回踩进场 + 分批建仓 + 趋势过滤
核心改进(针对追高吃回调问题):
1. 动量#1-#4选股(趋势候选)
2. 回踩进场: 不追高, 等价格回踩到 5日均线附近 或 回调2-3%才进
3. 分批建仓: 首次50%, 回调后补30%, 再跌补20%(金字塔)
4. SPY趋势过滤: 只在200日线上+20日动量正时做多
5. 止损15% + 移动止损锁利
含成本: 手续费0.15%×2 + 资金费0.03%/天
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

def run_roll(year):
    c = closes[(closes.index >= f'{year}-01-01') & (closes.index < f'{year + 1}-01-01')]
    if len(c) < 50: return None, None
    equity = 10000
    peak = 10000
    max_dd = 0
    # 持仓: {sym: {entry, qty_frac, stop, be, hold, trailed}}
    positions = {}
    last_pick = -999  # 上次选股日
    for i in range(20, len(c)):
        date = c.index[i]
        day = c.iloc[i]
        si = spy.index.get_indexer([date], method='ffill')[0]
        if si < 200: continue
        s200 = spy.iloc[si-200:si].mean()
        s20 = (spy.iloc[si] - spy.iloc[si-20]) / spy.iloc[si-20]
        bull = spy.iloc[si] > s200 and s20 > 0
        if not bull:
            positions = {}  # 趋势破坏全清
            continue
        # 每5天重新选股(动量候选)
        if i - last_pick >= 5:
            mom = {}
            for s in SYMS:
                cc = c[s].dropna()
                idx = cc.index.get_indexer([date], method='ffill')[0]
                if idx >= 20 and cc.iloc[idx] > 0:
                    mom[s] = (cc.iloc[idx] - cc.iloc[idx-20]) / cc.iloc[idx-20]
            ranked = sorted(mom, key=mom.get, reverse=True)
            candidates = ranked[:4]
            # 清理不在候选的持仓
            for sym in list(positions.keys()):
                if sym not in candidates:
                    # 平掉
                    p = positions.pop(sym)
                    price = day[sym]
                    if not np.isnan(price):
                        ret = (price - p['entry']) / p['entry'] * LEVER * p['qty_frac'] - FEE_TICK * LEVER * p['qty_frac'] * 2
                        equity *= (1 + ret)
            last_pick = i
            # 候选: 等回踩进场(不追高)
            for sym in candidates:
                if sym in positions: continue
                price = day[sym]
                if np.isnan(price) or price <= 0: continue
                # 回踩确认: 价格距5日均线 < 1.5% (回踩到均线附近才进)
                ma5 = c[sym].iloc[i-5:i].mean()
                dist_ma5 = abs(price / ma5 - 1)
                if dist_ma5 > 0.03:  # 离均线太远=追高, 等回踩
                    continue
                # 分批: 先开50%
                w = 0.309 * 0.5
                positions[sym] = {'entry': price, 'qty_frac': w, 'stop': price * 0.85,
                                  'be': price, 'hold': 0, 'trailed': False, 'added': False}
        # 管理持仓
        for sym in list(positions.keys()):
            p = positions[sym]
            price = day[sym]
            if np.isnan(price): continue
            p['hold'] += 1
            fund = FUNDING_DAY * LEVER * p['qty_frac']
            def cr(pr): return pr * LEVER * p['qty_frac'] - FEE_TICK * LEVER * p['qty_frac'] * 2 - fund * p['hold']
            pnl = (price - p['entry']) / p['entry']
            # 移动止损
            if pnl >= 0.10: p['be'] = max(p['be'], p['entry']); p['trailed'] = True
            if pnl >= 0.20: p['be'] = max(p['be'], p['entry'] * 1.10)
            # 补仓: 回调3%补30%(金字塔)
            if not p['added'] and pnl <= -0.03:
                add_w = p['qty_frac'] * 0.6  # 补原仓60%
                p['qty_frac'] += add_w
                p['entry'] = (p['entry'] * (p['qty_frac'] - add_w) + price * add_w) / p['qty_frac']
                p['added'] = True
            # 止盈40%
            if price >= p['entry'] * 1.40:
                ret = cr(0.40)
                equity *= (1 + ret)
                positions.pop(sym)
                continue
            # 超时10天
            if p['hold'] >= 10:
                ret = cr((price - p['entry']) / p['entry'])
                equity *= (1 + ret)
                positions.pop(sym)
                continue
            # 止损
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

print('=== 成熟策略 v10 (动量+回踩+分批+趋势过滤) ===')
print('年份 | 期末 | 收益率 | 回撤')
eqs = []
for year in [2022, 2023, 2024, 2025, 2026]:
    eq, dd = run_roll(year)
    if eq is None:
        print(f'{year}: 数据不足')
        continue
    eqs.append(eq)
    print(f'{year} | {eq:>10,.0f} | {(eq/10000-1)*100:+8.1f}% | {dd*100:.1f}%')
if eqs:
    print(f'\n5年均值: {np.mean(eqs):,.0f} | 平均回撤见上')
