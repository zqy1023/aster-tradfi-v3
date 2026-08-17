import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const envPath = process.env.ASTER_ENV_FILE || '/etc/aster-tradfi-v3.env';
const targetDatabase = process.env.ASTER_TARGET_DB || 'aster_quant';
const values = {};
for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const sourceDatabase = values.DB_NAME;
const useSocketRoot = process.env.ASTER_USE_SOCKET_ROOT === 'true';
if (!/^[a-zA-Z0-9_]+$/.test(sourceDatabase) || !/^[a-zA-Z0-9_]+$/.test(targetDatabase)) throw new Error('数据库名不合法');

const connection = await mysql.createConnection({
  host: values.DB_HOST || '127.0.0.1',
  port: Number(values.DB_PORT || 3306),
  socketPath: values.DB_SOCKET || undefined,
  user: useSocketRoot ? 'root' : values.DB_USER,
  password: useSocketRoot ? process.env.ASTER_DB_ROOT_PASSWORD : values.DB_PASSWORD,
  multipleStatements: false,
  timezone: 'Z',
});

const quote = (value) => `\`${String(value).replaceAll('`', '``')}\``;
try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${quote(targetDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const [rows] = await connection.query(`SHOW FULL TABLES FROM ${quote(sourceDatabase)} WHERE Table_type = 'BASE TABLE'`);
  const tables = rows.map((row) => Object.values(row)[0]);
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  await connection.query(`USE ${quote(targetDatabase)}`);
  for (const table of tables) {
    const [definitionRows] = await connection.query(`SHOW CREATE TABLE ${quote(sourceDatabase)}.${quote(table)}`);
    const createSql = definitionRows[0]['Create Table'].replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ');
    await connection.query(createSql);
  }
  for (const table of tables) {
    await connection.query(`INSERT IGNORE INTO ${quote(targetDatabase)}.${quote(table)} SELECT * FROM ${quote(sourceDatabase)}.${quote(table)}`);
  }
  await connection.query('SET FOREIGN_KEY_CHECKS=1');
  let sourceRows = 0;
  let targetRows = 0;
  for (const table of tables) {
    const [[sourceCount]] = await connection.query(`SELECT COUNT(*) AS count FROM ${quote(sourceDatabase)}.${quote(table)}`);
    const [[targetCount]] = await connection.query(`SELECT COUNT(*) AS count FROM ${quote(targetDatabase)}.${quote(table)}`);
    sourceRows += Number(sourceCount.count);
    targetRows += Number(targetCount.count);
    if (Number(sourceCount.count) !== Number(targetCount.count)) throw new Error(`${table} 行数不一致`);
  }
  process.stdout.write(`${JSON.stringify({ sourceDatabase, targetDatabase, tables: tables.length, sourceRows, targetRows, verified: sourceRows === targetRows }, null, 2)}\n`);
} finally {
  await connection.end();
}
