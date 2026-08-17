function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export class MySQLResearchRepository {
  constructor(pool) { this.pool = pool; }

  static async fromEnv() {
    const mysql = await import('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      socketPath: process.env.DB_SOCKET || undefined,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'aster_quant_v2',
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
      timezone: 'Z',
      decimalNumbers: true,
    });
    await pool.query('SELECT 1');
    return new MySQLResearchRepository(pool);
  }

  async createJob(job) {
    await this.pool.execute(
      `INSERT INTO ai_research_jobs (id,tenant_id,created_by,provider,status,current_stage,progress,request_json,candidate_id,failure_reason,created_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [job.id, job.tenantId, job.userId, job.provider, job.status, job.currentStage, job.progress, JSON.stringify(job.request), job.candidateId, job.failureReason, job.createdAt, job.completedAt],
    );
    return job;
  }

  async updateJob(id, patch) {
    const fields = { status: 'status', currentStage: 'current_stage', progress: 'progress', candidateId: 'candidate_id', failureReason: 'failure_reason', completedAt: 'completed_at' };
    const updates = [];
    const values = [];
    for (const [key, column] of Object.entries(fields)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) { updates.push(`${column}=?`); values.push(patch[key]); }
    }
    if (updates.length) { values.push(id); await this.pool.execute(`UPDATE ai_research_jobs SET ${updates.join(',')} WHERE id=?`, values); }
    return this.getJob(id);
  }

  async getJob(id) {
    const [rows] = await this.pool.execute('SELECT * FROM ai_research_jobs WHERE id=? LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, tenantId: String(row.tenant_id), userId: String(row.created_by), provider: row.provider, status: row.status, currentStage: row.current_stage, progress: row.progress, request: parseJson(row.request_json, {}), candidateId: row.candidate_id, failureReason: row.failure_reason, createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null };
  }

  async listJobs(tenantId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
    const [rows] = await this.pool.execute(`SELECT * FROM ai_research_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ${safeLimit}`, [tenantId]);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), userId: String(row.created_by), provider: row.provider, status: row.status, currentStage: row.current_stage, progress: row.progress, request: parseJson(row.request_json, {}), candidateId: row.candidate_id, failureReason: row.failure_reason, createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null }));
  }

  async addEvent(id, event) {
    const job = await this.getJob(id);
    if (!job) throw new Error('研究任务不存在');
    const stage = event.message.match(/^阶段(?:完成|已排队)：(.+)$/)?.[1] || null;
    await this.pool.execute(
      'INSERT INTO ai_research_events (id,job_id,tenant_id,stage,message,details_json,created_at) VALUES (?,?,?,?,?,?,?)',
      [event.id, id, job.tenantId, stage, event.message, JSON.stringify(event.details || {}), event.createdAt],
    );
    return event;
  }

  async getEvents(id) {
    const [rows] = await this.pool.execute('SELECT id,job_id,stage,message,details_json,created_at FROM ai_research_events WHERE job_id=? ORDER BY created_at,id', [id]);
    return rows.map((row) => ({ id: row.id, jobId: row.job_id, stage: row.stage, message: row.message, details: parseJson(row.details_json, {}), createdAt: new Date(row.created_at).toISOString() }));
  }

  async saveCandidate(candidate) {
    await this.pool.execute(
      `INSERT INTO strategy_candidates (id,job_id,tenant_id,created_by,version_no,status,spec_json,approved_by,approved_at,rejected_by,rejected_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status),spec_json=VALUES(spec_json),approved_by=VALUES(approved_by),approved_at=VALUES(approved_at),rejected_by=VALUES(rejected_by),rejected_at=VALUES(rejected_at)`,
      [candidate.id, candidate.jobId, candidate.tenantId, candidate.createdBy, candidate.version, candidate.status, JSON.stringify(candidate.spec), candidate.approvedBy || null, candidate.approvedAt || null, candidate.rejectedBy || null, candidate.rejectedAt || null, candidate.createdAt],
    );
    return candidate;
  }

  async getCandidate(id) {
    const [rows] = await this.pool.execute('SELECT * FROM strategy_candidates WHERE id=? LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, jobId: row.job_id, tenantId: String(row.tenant_id), createdBy: String(row.created_by), version: row.version_no, status: row.status, spec: parseJson(row.spec_json, {}), createdAt: new Date(row.created_at).toISOString(), approvedBy: row.approved_by ? String(row.approved_by) : null, approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null, rejectedBy: row.rejected_by ? String(row.rejected_by) : null, rejectedAt: row.rejected_at ? new Date(row.rejected_at).toISOString() : null };
  }
}
