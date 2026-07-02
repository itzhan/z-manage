import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || '';
  const page = Math.max(1, parseInt(sp.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50')));

  let where = '1=1';
  if (status === 'available') where = "used = 0 AND allocatedTo IS NULL";
  else if (status === 'used') where = "used = 1";
  else if (status === 'allocated') where = "allocatedTo IS NOT NULL";

  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) as c FROM openai_pool WHERE ${where}`).get() as any).c;
  const items = db.prepare(`SELECT * FROM openai_pool WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);

  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const accounts = body.accounts || body.items || body;
  if (!Array.isArray(accounts)) return NextResponse.json({ error: 'Expected array' }, { status: 400 });

  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO openai_pool (id, email, password, msRefreshToken, addedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password = COALESCE(excluded.password, openai_pool.password),
      msRefreshToken = COALESCE(excluded.msRefreshToken, openai_pool.msRefreshToken)
  `);

  let imported = 0;
  const insert = db.transaction((items: any[]) => {
    for (const item of items) {
      if (!item.email) continue;
      stmt.run(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, item.email.trim().toLowerCase(), item.password || null, item.msRefreshToken || null, now);
      imported++;
    }
  });
  insert(accounts);

  return NextResponse.json({ imported });
}
