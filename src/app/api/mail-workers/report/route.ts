import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_staging (
      id        TEXT PRIMARY KEY,
      email     TEXT NOT NULL UNIQUE,
      password  TEXT NOT NULL,
      source    TEXT DEFAULT 'worker',
      createdAt TEXT NOT NULL
    )
  `);
  return db;
}

// POST: Worker 上报注册成功的账号 → 写入暂存区（不直接入库 mailcom）
export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const batch: { email: string; password: string }[] = body.batch ?? [];
  const source: string = body.source ?? 'worker';

  if (batch.length === 0) {
    return NextResponse.json({ error: 'empty batch' }, { status: 400 });
  }

  const db = ensureTable();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO mail_staging (id, email, password, source, createdAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const item of batch) {
      if (!item.email || !item.password) continue;
      const email = item.email.trim().toLowerCase();
      const id = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const info = stmt.run(id, email, item.password.trim(), source, now);
      if (info.changes > 0) added++;
    }
  });
  tx();

  const total = (db.prepare('SELECT COUNT(*) as c FROM mail_staging').get() as any).c;
  return NextResponse.json({ added, total }, { status: 201 });
}
