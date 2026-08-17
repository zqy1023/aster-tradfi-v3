#!/usr/bin/env python3
"""10年数据策略研究: KORU/SOXL (OKX永续池, 完全重叠)
验证: 波动率突破 vs 动量 vs 均值回归
方法: 分年度验证 + 70/30跨期 + 含成本(0.09%双边)
规则: 分年度多数为正 + 跨期验证为正 才可交易
"""
import pyarrow.parquet as pq
import pandas as pd
import numpy as np

FEE = 0.0009
YEARS = 10

def load(sym):
    df = pq.read_table(f'/opt/aster-equity/data/import/cash_equity_daily/{sym}-USDT-SWAP.parquet').to_pandas()
    df.index = pd.to_datetime(df.index)
    df = df[~df.index.duplicated()].sort_index()
    return df

def breakout(df, lb=20, mult=1.5, hold=3):
    """波动率突破: 收盘突破 均线+mult×ATR → 持有hold天"""
    closes = df['close'].dropna()
    if len(closes) < 60: return None, 0, 0, []
    tr = pd.concat([closes.diff(), closes - closes.rolling(2).max().shift(), closes.rolling(2).min().shift() - closes], axis=1).max(axis=1)
    atr = tr.rolling(lb).mean()
    ma = closes.rolling(lb).mean()
    eq, trades, wins, year_rets = 100, 0, 0, {}
    pos, entry, hold_left = 0, 0, 0
    cur_year = None
    for i in range(lb + 5, len(closes)):
        year = closes.index[i].year
        if cur_year != year:
            cur_year = year
            year_rets[year] = 1.0  # 每年独立起始
        if pos == 0:
            upper = ma.iloc[i] + mult * atr.iloc[i]
            if closes.iloc[i] > upper:
                pos, entry, hold_left = 1, closes.iloc[i], hold
        elif pos == 1:
            hold_left -= 1
            if hold_left <= 0:
                r = (closes.iloc[i] - entry) / entry - FEE
                eq *= (1 + r); trades += 1; wins += (r > 0)
                year_rets[cur_year] *= (1 + r)
                pos = 0
    if pos == 1:
        r = (closes.iloc[-1] - entry) / entry - FEE
        eq *= (1 + r); trades += 1; wins += (r > 0)
        year_rets[cur_year] *= (1 + r)
    return eq, trades, wins / max(1, trades), year_rets

def momentum(df, lb=20, hold=5, thresh=0.1):
    """动量: 过去lb天收益>thresh → 做多持有hold天"""
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

def meanrev(df, lb=14, z=2.0, hold=3):
    """均值回归: 收盘 < 均线-2σ → 做多持有hold天"""
    closes = df['close'].dropna()
    eq, trades, wins = 100, 0, 0
    pos, entry, hold_left = 0, 0, 0
    sma = closes.rolling(lb).mean()
    std = closes.rolling(lb).std()
    for i in range(lb + 5, len(closes)):
        if pos == 0:
            lower = sma.iloc[i] - z * std.iloc[i]
            if closes.iloc[i] < lower and std.iloc[i] > 0:
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

for sym in ['KORU', 'SOXL']:
    df = load(sym)
    print(f'\n{"="*60}\n{sym}: {len(df)}行 ({df.index[0].year}-{df.index[-1].year})')
    print(f'价格: {df["close"].min():.1f} ~ {df["close"].max():.1f}')

    # 波动率突破: 全样本 + 分年度
    eq, tr, wr, years = breakout(df)
    pos_years = sum(1 for v in years.values() if v > 1)
    print(f'\n[波动率突破 20/1.5/3] 全样本: 100→{eq:.0f} | {tr}笔 | 胜率{wr*100:.1f}%')
    print(f'  分年度: {" ".join(f"{y}:{v:.2f}" for y, v in sorted(years.items()))}')
    print(f'  正收益年份: {pos_years}/{len(years)}')

    # 动量
    eq2, tr2, wr2 = momentum(df)
    print(f'\n[动量 20/5/10%] 全样本: 100→{eq2:.0f} | {tr2}笔 | 胜率{wr2*100:.1f}%')

    # 均值回归
    eq3, tr3, wr3 = meanrev(df)
    print(f'[均值回归 14/2σ/3] 全样本: 100→{eq3:.0f} | {tr3}笔 | 胜率{wr3*100:.1f}%')

    # 跨期验证: 前70%训练, 后30%验证
    split = int(len(df) * 0.7)
    e1, t1, w1, _ = breakout(df.iloc[:split])
    e2, t2, w2, _ = breakout(df.iloc[split:])
    print(f'\n[跨期] 突破: 训练100→{e1:.0f}({t1}笔) | 验证100→{e2:.0f}({t2}笔, 胜率{w2*100:.1f}%)')
