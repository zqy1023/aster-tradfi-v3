#!/usr/bin/env python3
"""2025年亏损原因分析"""
import pyarrow.parquet as pq
import pandas as pd

spy = pq.read_table('/opt/aster-equity/data/import/cash_equity_daily/SPY-BENCHMARK.parquet').to_pandas()
spy.index = pd.to_datetime(spy.index)
spy = spy[~spy.index.duplicated()].sort_index()
s25 = spy[(spy.index >= '2025-01-01') & (spy.index < '2026-01-01')]['close']
print('2025 SPY: 年初', round(s25.iloc[0], 1), '→ 年末', round(s25.iloc[-1], 1))
print('2025 SPY 全年:', f'{(s25.iloc[-1]/s25.iloc[0]-1)*100:+.1f}%')

mom_pos = sum(1 for i in range(20, len(s25)) if (s25.iloc[i] - s25.iloc[i-20]) / s25.iloc[i-20] > 0)
print(f'20日动量为正天数: {mom_pos}/{len(s25)-20} ({(mom_pos/(len(s25)-20)*100):.0f}%)')

# 200日线
s25_200 = s25.rolling(200).mean()
bull = sum(1 for i in range(200, len(s25)) if s25.iloc[i] > s25_200.iloc[i])
print(f'收盘在200日线上方: {bull}/{len(s25)-200}')

# 分季度
for q in [('Q1', '01-01', '04-01'), ('Q2', '04-01', '07-01'), ('Q3', '07-01', '10-01'), ('Q4', '10-01', '12-31')]:
    seg = s25[(s25.index >= f'2025-{q[1]}') & (s25.index < f'2025-{q[2]}')]
    if len(seg) > 1:
        print(f'2025{q[0]}: {(seg.iloc[-1]/seg.iloc[0]-1)*100:+.1f}%')
