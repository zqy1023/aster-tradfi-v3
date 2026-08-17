import { createHash } from 'node:crypto';

const MACRO_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NASDAQ_URL = 'https://api.nasdaq.com/api/calendar/earnings';
const ttlMs = 15 * 60 * 1000;
const keyFor = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function earningsTime(day, label = '') {
  const hour = /after/i.test(label) ? 21 : /before/i.test(label) ? 12 : 16;
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

export class MarketEventService {
  constructor({ fetchImpl = fetch, repository = null, clock = () => new Date() } = {}) {
    this.fetchImpl = fetchImpl;
    this.repository = repository;
    this.clock = clock;
    this.cache = null;
  }

  async fetchJson(url, headers = {}) {
    const response = await this.fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 ASTER-TradFi/3.0', accept: 'application/json', ...headers }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async load(symbols = []) {
    const wanted = new Set(symbols.map((symbol) => String(symbol).toUpperCase()).filter(Boolean));
    const now = this.clock();
    if (!this.cache || now.getTime() - this.cache.loadedAt > ttlMs) this.cache = await this.refresh(now);
    return {
      ...this.cache,
      // 财报返回全部（前端自行标注哪些匹配候选池）；候选池匹配数量单独给出
      earnings: this.cache.earnings,
      earningsMatched: wanted.size ? this.cache.earnings.filter((event) => wanted.has(event.symbol)) : [],
    };
  }

  async refresh(now) {
    const recvTs = now.toISOString();
    const errors = [];
    let macro = [];
    let earnings = [];
    try {
      // 宏观源：faireconomy 需要浏览器 UA（429 限流时重试一次）
      const rows = await this.fetchJson(MACRO_URL, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' })
        .catch(async () => this.fetchJson(MACRO_URL, { 'user-agent': 'Mozilla/5.0 ASTER-TradFi/3.0' }));
      const important = /CPI|Consumer Price|Non-Farm|Employment|FOMC|Federal Reserve|Fed Chair|PCE|GDP/i;
      macro = (Array.isArray(rows) ? rows : []).filter((row) => row.country === 'USD' && (row.impact === 'High' || important.test(String(row.title || '')))).map((row) => ({
        key: keyFor('macro', row.title, row.date), type: 'macro', symbol: null, title: String(row.title || '美国宏观事件'), time: new Date(row.date).toISOString(), impact: String(row.impact || ''), forecast: String(row.forecast || ''), previous: String(row.previous || ''), source: 'faireconomy-calendar', recvTs, raw: row,
      }));
    } catch (error) { errors.push(`宏观日历：${error.message}`); }

    const days = Array.from({ length: 7 }, (_, index) => new Date(now.getTime() + index * 86_400_000));
    const results = await Promise.allSettled(days.map(async (day) => {
      const date = dateOnly(day);
      const payload = await this.fetchJson(`${NASDAQ_URL}?date=${date}`, { origin: 'https://www.nasdaq.com' });
      return (payload?.data?.rows || []).map((row) => ({
        key: keyFor('earnings', row.symbol, date), type: 'earnings', symbol: String(row.symbol || '').toUpperCase(), title: `${row.symbol || ''} ${row.name || '财报'}`.trim(), time: earningsTime(date, row.time), impact: String(row.time || '时间待定'), forecast: String(row.epsForecast || row.eps_forecast || ''), previous: String(row.lastYearEPS || row.last_year_eps || ''), source: 'nasdaq-earnings', recvTs, raw: row,
      }));
    }));
    for (const result of results) {
      if (result.status === 'fulfilled') earnings.push(...result.value);
      else errors.push(`财报日历：${result.reason?.message || '请求失败'}`);
    }
    earnings = [...new Map(earnings.map((event) => [event.key, event])).values()];
    const all = [...macro, ...earnings];
    if (this.repository && all.length) await this.repository.saveMarketEvents(all).catch((error) => errors.push(`事件入库：${error.message}`));
    // 状态语义：live=至少一个源有数据且无错误；partial=有数据但有源失败；disconnected=全失败
    const macroOk = !errors.some((e) => e.includes('宏观'));
    const earningsOk = !errors.some((e) => e.includes('财报'));
    const state = all.length ? (errors.length ? 'partial' : 'live') : 'disconnected';
    return { loadedAt: now.getTime(), generatedAt: recvTs, macro, earnings, state, macroState: macroOk ? (macro.length ? 'live' : 'empty') : 'error', earningsState: earningsOk ? (earnings.length ? 'live' : 'empty') : 'error', errors };
  }
}
