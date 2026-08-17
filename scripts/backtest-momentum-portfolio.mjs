#!/usr/bin/node
// Monthly cross-sectional momentum portfolio backtest.
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || 'data/equity-daily-proxy.json';
const raw = JSON.parse(await readFile(file, 'utf8'));
const minHistory = 252;
const topN = 5;
const targetAnnualVol = 0.30;
const turnoverCost = 0.0021;
const grossLeverageCap = 1.0;

function monthKey(ts) { return new Date(ts).toISOString().slice(0, 7); }
function realizedVol(candles, endIdx) {
  const start = Math.max(1, endIdx - 20);
  const rets = [];
  for (let i = start + 1; i <= endIdx; i++) rets.push(candles[i].c / candles[i - 1].c - 1);
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rets.length - 1) * 252);
}
export function backtest(raw) {
  const byMonth = new Map();
  for (const [sym, rows] of Object.entries(raw)) {
    const clean = rows.filter(c => Number(c.c) > 0 && Number(c.ts)).sort((a, b) => a.ts - b.ts);
    for (let i = minHistory; i < clean.length; i++) {
      const key = monthKey(clean[i].ts);
      if (!byMonth.has(key)) byMonth.set(key, new Map());
      byMonth.get(key).set(sym, {sym, i, candles: clean, ret12m: clean[i].c / clean[i - minHistory].c - 1});
    }
  }
  const months = Array.from(byMonth.keys()).sort();
  let equity = 1;
  const prevSymbols = new Set();
  const trades = [];
  const monthlyReturns = [];
  for (const month of months) {
    const candidates = Array.from(byMonth.get(month).values()).filter(x => x.i < x.candles.length - 1).sort((a, b) => b.ret12m - a.ret12m).slice(0, topN);
    if (!candidates.length) continue;
    const legs = candidates.map(x => {
      const next = x.candles[x.i + 1];
      const vol = realizedVol(x.candles, x.i) ?? 0.45;
      const weight = Math.min(grossLeverageCap / topN, Math.min(grossLeverageCap, targetAnnualVol / vol) / topN);
      return {sym: x.sym, ret: next.c / x.candles[x.i].c - 1, weight, vol};
    });
    const changed = legs.filter(x => !prevSymbols.has(x.sym)).length + Array.from(prevSymbols).filter(sym => !legs.some(x => x.sym === sym)).length;
    const gross = legs.reduce((s, x) => s + x.ret * x.weight, 0);
    const cost = changed / topN * turnoverCost;
    const net = gross - cost;
    equity *= 1 + net;
    monthlyReturns.push(net);
    trades.push({month, changed, gross, cost, net, symbols: legs.map(x => x.sym), weights: legs.map(x => Number(x.weight.toFixed(3)))});
    prevSymbols.clear();
    for (const leg of legs) prevSymbols.add(leg.sym);
  }
  function metrics(rs) {
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rs.length - 1));
    let peak = 1, cur = 1, maxDD = 0;
    for (const r of rs) { cur *= 1 + r; peak = Math.max(peak, cur); maxDD = Math.max(maxDD, 1 - cur / peak); }
    return {annReturn: mean * 12, annVol: sd * Math.sqrt(12), sharpe: sd ? mean / sd * Math.sqrt(12) : 0, maxDD};
  }
  return {trades, summary: metrics(monthlyReturns), months: monthlyReturns.length, equity};
}
const result = backtest(raw);
console.log(JSON.stringify(result, null, 2));