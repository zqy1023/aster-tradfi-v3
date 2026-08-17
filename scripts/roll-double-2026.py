#!/usr/bin/env python3
"""2026年翻倍滚仓回测: 满仓动量#1 + 30%移动止损 + 翻倍全滚
规则:
- 每日收盘: 11标的算20日动量, 排名第1 = 标的
- 满仓(10x杠杆, 账户权益×10名义)
- 进场后: +30%止损上移保本, +60%上移+30%, +100%全部止盈翻倍
- 止损-30%无条件
- 翻倍后全仓滚入下一笔(不提取, 看极限)
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE = 0.0009
LEVER = 10
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

# 载入全部, 对齐日期
data = {s: load(s)['close'] for s in SYMS}
dates = sorted(set().union(*[set(d.index) for d in data.values()]))
closes = pd.DataFrame({s: d for s, d in data.items()}).ffill()

# 只取2026年
closes = closes[closes.index >= '2026-01-01']
print(f'2026年交易日: {len(closes)}天')

# 翻倍滚仓回测
equity = 10000  # 初始1万
peak = equity
trades = []
pos = None  # {sym, entry, qty_notional_mult}
trailing_stop = 0
base_equity = equity  # 翻倍基准

for i in range(20, len(closes)):
    date = closes.index[i]
    day = closes.iloc[i]
    
    if pos is None:
        # 选动量#1
        mom = {}
        for s in SYMS:
            c = closes[s].dropna()
            idx = c.index.get_indexer([date], method='ffill')[0]
            if idx >= 20:
                mom[s] = (c.iloc[idx] - c.iloc[idx-20]) / c.iloc[idx-20]
        if not mom: continue
        best = max(mom, key=mom.get)
        entry = day[best]
        if not np.isnan(entry) and entry > 0:
            pos = {'sym': best, 'entry': entry, 'momentum': mom[best]}
            trailing_stop = entry * 0.7  # -30% 止损
            base_equity = equity  # 本笔基准
    else:
        sym = pos['sym']
        price = day[sym]
        if np.isnan(price): continue
        # 检查移动止损
        if price <= trailing_stop:
            # 止损出局
            loss = (price - pos['entry']) / pos['entry'] * LEVER - FEE * LEVER
            equity *= (1 + loss / LEVER)  # 用杠杆后实际损益
            # 简化: 实际收益 = 价格变动×杠杆 - 手续费
            ret = (price - pos['entry']) / pos['entry'] * LEVER - FEE * LEVER
            trades.append({'date': date, 'sym': sym, 'type': '止损', 'entry': pos['entry'], 'exit': price, 'ret': ret, 'equity': equity})
            pos = None
            continue
        # 移动止损上移: +30% 保本, +60% 锁+30%
        if price >= pos['entry'] * 1.30:
            trailing_stop = max(trailing_stop, pos['entry'] * 1.0)  # 保本
        if price >= pos['entry'] * 1.60:
            trailing_stop = max(trailing_stop, pos['entry'] * 1.30)  # 锁30%
        # 翻倍止盈: 价格×杠杆收益 >= 100% 基准
        ret_now = (price - pos['entry']) / pos['entry'] * LEVER
        if ret_now >= 1.0:
            ret = ret_now - FEE * LEVER
            equity *= (1 + ret)
            trades.append({'date': date, 'sym': sym, 'type': '翻倍止盈', 'entry': pos['entry'], 'exit': price, 'ret': ret, 'equity': equity})
            pos = None

# 尾仓
if pos:
    sym = pos['sym']
    price = closes.iloc[-1][sym]
    ret = (price - pos['entry']) / pos['entry'] * LEVER - FEE * LEVER
    equity *= (1 + ret)
    trades.append({'date': closes.index[-1], 'sym': sym, 'type': '期末平', 'entry': pos['entry'], 'exit': price, 'ret': ret, 'equity': equity})

print(f'\n=== 2026年翻倍滚仓结果 ===')
print(f'初始: 10,000 → 期末: {equity:,.0f} USDT')
print(f'收益率: {(equity/10000-1)*100:+.1f}%')
print(f'交易笔数: {len(trades)}')
wins = sum(1 for t in trades if t['ret'] > 0)
print(f'盈利笔: {wins} | 亏损笔: {len(trades)-wins}')
print(f'\n=== 每笔明细 ===')
for t in trades:
    print(f"{t['date'].strftime('%m-%d')} {t['sym']:>8} {t['type']} | 进{t['entry']:.0f} 出{t['exit']:.0f} | 笔收益{t['ret']*100:+.1f}% | 账户{t['equity']:,.0f}")
