// 用法: node create-user.mjs <username> <displayName> <password> [role]
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const [username, displayName, password, role = 'trader'] = process.argv.slice(2);
if (!username || !displayName || !password) { console.error('用法: node create-user.mjs <username> <显示名> <密码> [role]'); process.exit(1); }
const env = await readFile('/etc/aster-tradfi-v3.env', 'utf8');
const vals = {};
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) vals[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
const conn = await mysql.createConnection({ socketPath: vals.DB_SOCKET, user: vals.DB_USER, password: vals.DB_PASSWORD, database: vals.DB_NAME });
// 哈希密码（与 auth-service.mjs hashPassword 一致）
const salt = randomBytes(16).toString('base64url');
const derived = scryptSync(String(password), salt, 32, { N: 16_384, r: 8, p: 1 });
const hash = `scrypt$16384$8$1$${salt}$${derived.toString('base64url')}`;
try {
  const [admin] = await conn.execute("SELECT id, tenant_id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1");
  const tenantId = admin[0]?.tenant_id || 1;
  const [result] = await conn.execute(
    'INSERT INTO users (tenant_id, email, display_name, role, status) VALUES (?, ?, ?, ?, "active")',
    [tenantId, `${username}@wydwlh.icu`, displayName, role],
  );
  await conn.execute(
    'INSERT INTO user_credentials (user_id, username, password_hash) VALUES (?, ?, ?)',
    [result.insertId, username, hash],
  );
  console.log(`✅ 用户创建成功: ${username} (${displayName}, role=${role}, id=${result.insertId})`);
} finally { await conn.end(); }
