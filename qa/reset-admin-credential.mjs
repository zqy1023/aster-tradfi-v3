import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { hashPassword } from '../backend/auth-service.mjs';

const envPath = process.env.ASTER_ENV_FILE || '/etc/aster-tradfi-v3.env';
const secretPath = process.env.ASTER_ADMIN_SECRET_FILE || '/root/aster-admin-initial.txt';
const username = process.env.ASTER_ADMIN_USERNAME || 'admin';
const values = {};

for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const password = randomBytes(18).toString('base64url');
const connection = await mysql.createConnection({
  host: values.DB_HOST || '127.0.0.1',
  port: Number(values.DB_PORT || 3306),
  socketPath: values.DB_SOCKET || undefined,
  user: values.DB_USER,
  password: values.DB_PASSWORD,
  database: values.DB_NAME,
});

try {
  const [result] = await connection.execute(
    'UPDATE user_credentials SET password_hash=?,updated_at=UTC_TIMESTAMP(3) WHERE username=?',
    [hashPassword(password), username],
  );
  if (result.affectedRows !== 1) throw new Error(`网站账号 ${username} 不存在或不唯一`);
  await writeFile(secretPath, `${password}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ username, affectedRows: result.affectedRows, secretPath })}\n`);
} finally {
  await connection.end();
}
