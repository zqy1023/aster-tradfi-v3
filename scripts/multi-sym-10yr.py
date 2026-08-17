#!/usr/bin/env python3
"""多标的 10 年验证: 波动率突破 + 动量
标: KORU/SOXL/NVDA/INTC/MU/MRVL/LITE/MSTR/GOOGL/TSLA/SAMSUNG (11个, 2513行)
方法: 每标的独立回测 + 汇总 + 分年度
规则: 多数标的为正 + 跨期稳定 → 可交易
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE = 0.0009
SYMS = ['KORU', 'SOXL', 'NVDA', 'INTC', 'MU', 'MRVL', 'LITE', 'MSTR', 'GOOGL', 'TSLA', 'SAMSUNG']

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    return df[~df.index.duplicated()].sort_index()

def breakout(df, lb=20, mult=1.5, hold=3):
    closes = df['close'].dropna()
    if len(closes) < 60: return None, 0, 0
    tr = pd.concat([closes.diff(), closes - closes.rolling(2).max().shift(), closes.rolling(2).min().shift() - closes], axis=1).max(axis=1)
    atr = tr.rolling(lb).mean()
    ma = closes.rolling(lb).mean()
    eq, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lb + 5, len(closes)):
        if pos == 0:
            upper = ma.iloc[i] + mult * atr.iloc[i]
            if closes.iloc[i] > upper:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    if pos == 1:
        r = (closes.iloc[-1] - entry) / entry - FEE
        eq *= (1 + r); trades += 1; wins += (r > 0)
    return eq, trades, wins / max(1, trades)

def momentum(df, lb=20, hold=5, thresh=0.1):
    closes = df['close'].dropna()
    eq, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    for i in range(lb + 5, len(closes)):
        if pos == 0:
            mom = (closes.iloc[i] - closes.iloc[i - lb]) / closes.iloc[i - lb]
            if mom >= thresh:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                pos = 0
    if pos == 1:
        r = (closes.iloc[-1] - entry) / entry - FEE
        eq *= (1 + r); trades += 1; wins += (r > 0)
    return eq, trades, wins / max(1, trades)

print('='*70)
print('多标的 10 年验证 (2016-2026, 含0.09%手续费)')
print('='*70)
print(f'{"标的":>8} | {"突破全样本":>10} {"突破验证":>10} {"动量全样本":>10} {"动量验证":>10} | {"突破胜率":>8}')

brk_pos = mom_pos = 0
total_brk = total_mom = 0
for sym in SYMS:
    try:
        df = load(sym)
        split = int(len(df) * 0.7)
        b1, t1, w1 = breakout(df.iloc[:split])
        b2, t2, w2 = breakout(df.iloc[split:])
        m1, mt1, mw1 = momentum(df.iloc[:split])
        m2, mt2, mw2 = momentum(df.iloc[split:])
        b_all, _, _ = breakout(df)
        m_all, _, _ = momentum(df)
        # 判定: 验证期 > 100 为正
        b_ok = (b2 or 0) > 100
        m_ok = (m2 or 0) > 100
        brk_pos += b_ok; mom_pos += m_ok
        total_brk += t1 + t2; total_mom += mt1 + mt2
        print(f'{sym:>8} | {b_all:10.0f} {b2 or 0:10.0f} | {m_all:10.0f} {m2 or 0:10.0f} | {(w2 or 0)*100:7.1f}%')
    except Exception as e:
        print(f'{sym:>8} | 失败 {e}')

print(f'\n突破验证正收益: {brk_pos}/{len(SYMS)} | 动量验证正收益: {mom_pos}/{len(SYMS)}')
print(f'突破总交易: {total_brk} | 动量总交易: {total_mom}')
