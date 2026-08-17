import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const envPath = process.env.ASTER_ENV_FILE || '/etc/aster-tradfi-v3.env';
const values = {};
for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!match) continue;
  values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const pool = mysql.createPool({
  host: values.DB_HOST || '127.0.0.1',
  port: Number(values.DB_PORT || 3306),
  socketPath: values.DB_SOCKET || undefined,
  user: values.DB_USER,
  password: values.DB_PASSWORD,
  database: values.DB_NAME,
  connectionLimit: 1,
  timezone: 'Z',
});

try {
  const [candles] = await pool.query('SELECT timeframe, COUNT(*) AS rowCount, COUNT(DISTINCT inst_id) AS instruments, MIN(open_time) AS oldest, MAX(open_time) AS newest FROM market_candles GROUP BY timeframe ORDER BY timeframe');
  const [facts] = await pool.query(`SELECT
    (SELECT COUNT(*) FROM instruments) AS instruments,
    (SELECT COUNT(*) FROM market_ticker_snapshots) AS tickerSnapshots,
    (SELECT COUNT(*) FROM market_orderbook_snapshots) AS orderbookSnapshots,
    (SELECT COUNT(*) FROM market_trades) AS marketTrades,
    (SELECT COUNT(*) FROM exchange_accounts) AS exchangeAccounts,
    (SELECT COUNT(*) FROM exchange_fills) AS exchangeFills,
    (SELECT COUNT(*) FROM exchange_positions WHERE quantity <> 0) AS openPositions,
    (SELECT COUNT(*) FROM ai_research_jobs) AS researchJobs`);
  const [schemas] = await pool.query("SELECT TABLE_SCHEMA AS schemaName, COUNT(*) AS tables, COALESCE(SUM(TABLE_ROWS), 0) AS approximateRows FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('aster_quant','aster_quant_v2') GROUP BY TABLE_SCHEMA ORDER BY TABLE_SCHEMA");
  process.stdout.write(`${JSON.stringify({ activeDatabase: values.DB_NAME, schemas, candles, facts: facts[0] }, null, 2)}\n`);
} finally {
  await pool.end();
}
