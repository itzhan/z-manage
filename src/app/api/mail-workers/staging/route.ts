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

// GET: 获取暂存区列表（分页）
export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = ensureTable();
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get('page') || '1'));
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50')));
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as c FROM mail_staging').get() as any).c;
  const data = db.prepare('SELECT * FROM mail_staging ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(limit, offset);

  return NextResponse.json({ data, total, page, limit });
}

// POST: 一键导入到 mailcom_accounts
export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const ids: string[] | undefined = body.ids;

  const db = ensureTable();
  const now = new Date().toISOString();

  let rows: any[];
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM mail_staging WHERE id IN (${placeholders})`).all(...ids) as any[];
  } else {
    rows = db.prepare('SELECT * FROM mail_staging').all() as any[];
  }

  if (rows.length === 0) {
    return NextResponse.json({ imported: 0 });
  }

  const insertStmt = db.prepare(`
    INSERT INTO mailcom_accounts (id, email, password, banned, tokenStatus, addedAt)
    VALUES (?, ?, ?, 0, 'pending', ?)
    ON CONFLICT(email) DO NOTHING
  `);
  const deleteStmt = db.prepare('DELETE FROM mail_staging WHERE id = ?');

  let imported = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const mcId = `mc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const info = insertStmt.run(mcId, row.email, row.password, now);
      if (info.changes > 0) imported++;
      deleteStmt.run(row.id);
    }
  });
  tx();

  const remaining = (db.prepare('SELECT COUNT(*) as c FROM mail_staging').get() as any).c;
  return NextResponse.json({ imported, remaining });
}

// DELETE: 删除暂存区邮箱
export async function DELETE(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json().catch(() => ({}));
  const ids: string[] | undefined = body.ids;

  const db = ensureTable();

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM mail_staging WHERE id IN (${placeholders})`).run(...ids);
  } else {
    db.prepare('DELETE FROM mail_staging').run();
  }

  const remaining = (db.prepare('SELECT COUNT(*) as c FROM mail_staging').get() as any).c;
  return NextResponse.json({ ok: true, remaining });
}
