import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

interface MailWorkerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  maxThreads: number;
  createdAt: string;
}

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_workers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      host        TEXT NOT NULL,
      port        INTEGER DEFAULT 8098,
      maxThreads  INTEGER DEFAULT 10,
      createdAt   TEXT NOT NULL
    )
  `);
  return db;
}

// GET: 获取所有 mail worker 列表 + 实时状态
export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = ensureTable();
  const workers = db.prepare('SELECT * FROM mail_workers ORDER BY id').all() as MailWorkerRow[];

  // 获取代理池数量
  const proxyCount = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND bad = 0').get() as any)?.c ?? 0;

  // 并发 poll 所有 worker 的 /status
  const statuses = await Promise.allSettled(
    workers.map(async (w) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`http://${w.host}:${w.port}/status`, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        return { ...w, online: true, ...data };
      } catch {
        clearTimeout(timer);
        return { ...w, online: false, task: null, system: {} };
      }
    })
  );

  const result = statuses.map((s) =>
    s.status === 'fulfilled' ? s.value : { online: false, task: null, system: {} }
  );

  return NextResponse.json({ workers: result, proxyCount });
}

// POST: 添加/更新 mail worker
export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();

  // 批量导入
  if (Array.isArray(body.workers)) {
    const db = ensureTable();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO mail_workers (id, name, host, port, maxThreads, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, host=excluded.host, port=excluded.port, maxThreads=excluded.maxThreads
    `);
    const tx = db.transaction(() => {
      for (const w of body.workers) {
        stmt.run(w.id, w.name || w.id, w.host, w.port ?? 8098, w.maxThreads ?? 10, now);
      }
    });
    tx();
    return NextResponse.json({ ok: true, count: body.workers.length });
  }

  // 单个
  const id = body.id || `mw_${Date.now()}`;
  const db = ensureTable();
  db.prepare(`
    INSERT INTO mail_workers (id, name, host, port, maxThreads, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, host=excluded.host, port=excluded.port, maxThreads=excluded.maxThreads
  `).run(id, body.name || id, body.host, body.port ?? 8098, body.maxThreads ?? 10, new Date().toISOString());

  return NextResponse.json({ ok: true, id });
}

// DELETE: 删除 mail worker
export async function DELETE(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const db = ensureTable();
  db.prepare('DELETE FROM mail_workers WHERE id = ?').run(id);
  return NextResponse.json({ ok: true });
}
