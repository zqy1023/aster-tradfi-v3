// 12月动量代理数据源：Yahoo 现货日线（方案B：现货代理选股 + OKX 执行）
// 原因：OKX 美股永续历史最长仅 ~8 个月(167根日线)，不足 12 月动量所需 260 根。
// 用法：现货日线计算横截面动量排名，OKX 永续只做执行(价格/流动性/下单)。
// 诚实标注：前端显示"基于现货代理"，不冒充 OKX 数据。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.V3_DATA_DIR || path.resolve(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'equity-daily-proxy.json');
// 代理池：覆盖 OKX 实际成交的美股/ETF 永续对应现货（Yahoo 5年日线）
// 无 Yahoo 现货的（SKHYNIX/MINIMAX/KR200 等）不在池中，前端诚实标注"不在现货代理池"
const SYMBOLS = ['SNXX','KORU','SPCX','SNDK','XIAOMI','SKHY','CRCL','SOXL','SOXS','MSTR','INTC','MU','NOK','NVDA','TSLA','AMD','META','MSFT','AMZN','GOOGL','AAPL','COIN','PLTR','SNOW','RIVN','HOOD','GME','ARM','MRVL','DKNG','CSCO','TER','AMAT','ISRG','HPE','RIOT','IREN','WDC','ALAB','NOW','ROK','BX','CIEN','RDW','STRC','PENG','SKUU','AEHR','GLW','KO','SONY','LUNR','SIMO','FLNC','RDDT','MUU','XBI','TSEM','NG','URNM','IWM','QQQ','TQQQ','EWT','EWZ','XLE','FWDI','SPY','ONDS','COHR','INTW','KR'];
// OKX 永续 instId → 现货标的映射
const INST_TO_SYMBOL = Object.fromEntries(SYMBOLS.map((s) => [`${s}-USDT-SWAP`, s]));

export class EquityMomentumSource {
  constructor({ clock = () => new Date(), ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.candles = null; // { SYMBOL: [{ts,o,h,l,c,v}] }
    this.loadedAt = 0;
  }

  async load({ force = false } = {}) {
    if (!force && this.candles && this.clock() - this.loadedAt < this.ttlMs) return this.candles;
    try {
      const raw = await readFile(CACHE_FILE, 'utf8');
      this.candles = JSON.parse(raw);
      this.loadedAt = this.clock();
      this.source = 'yahoo-daily-proxy';
      return this.candles;
    } catch {
      this.candles = null;
      return null;
    }
  }

  async refresh() {
    // 拉取最新 Yahoo 日线并缓存（幂等，供每日定时更新）
    const out = {};
    for (const sym of SYMBOLS) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5y&interval=1d`;
        const resp = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        if (!resp.ok) continue;
        const j = await resp.json();
        const r = j.chart?.result?.[0];
        if (!r) continue;
        const ts = r.timestamp, q = r.indicators.quote?.[0];
        out[sym] = ts.map((t, i) => ({ ts: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
          .filter((x) => x.o && x.h && x.l && x.c);
      } catch { /* 单标失败不阻断 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (Object.keys(out).length >= 5) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(out));
      this.candles = out;
      this.loadedAt = this.clock();
      this.source = 'yahoo-daily-proxy';
    }
    return out;
  }

  // 计算横截面 12 月动量排名（含短窗口标的降级：<260根 用可用长度算相对动量）
  rankMomentum() {
    if (!this.candles) return new Map();
    const rows = [];
    for (const [sym, candles] of Object.entries(this.candles)) {
      const closes = candles.filter((c) => Number.isFinite(Number(c.c))).map((c) => Number(c.c));
      if (closes.length < 60) continue;
      const start = closes[closes.length - Math.min(252, closes.length - 1)];
      const end = closes.at(-1);
      rows.push({ sym, ret12m: start > 0 ? end / start - 1 : null });
    }
    const valid = rows.filter((r) => r.ret12m !== null && Number.isFinite(r.ret12m));
    valid.sort((a, b) => b.ret12m - a.ret12m);
    const map = new Map();
    valid.forEach((r, idx) => {
      map.set(r.sym, { rank: idx + 1, total: valid.length, return12m: r.ret12m });
    });
    return map;
  }

  // 按 OKX instId 取动量信息（无则 null）
  momentumFor(instId) {
    const sym = INST_TO_SYMBOL[instId];
    if (!sym) return null;
    return this.rankMomentum().get(sym) || null;
  }
}
