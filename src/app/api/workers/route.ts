import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const rows = db.prepare('SELECT * FROM workers ORDER BY createdAt DESC').all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const id = body.id || `w_${Date.now()}`;
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO workers (id, name, baseUrl, token, maxTasks, capabilities, browserType, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, baseUrl = excluded.baseUrl, token = excluded.token,
      maxTasks = excluded.maxTasks, capabilities = excluded.capabilities,
      browserType = excluded.browserType, updatedAt = excluded.updatedAt
  `).run(
    id,
    body.name || id,
    body.baseUrl || '',
    body.token || '',
    body.maxTasks ?? 5,
    JSON.stringify(body.capabilities ?? ['claude-platform-bindcard', 'platform-bindcard']),
    body.browserType || 'ads',
    now,
    now,
  );

  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  return NextResponse.json(worker);
}
