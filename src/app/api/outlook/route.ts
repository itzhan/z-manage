import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 50, 200);
  const offset = (page - 1) * limit;
  const search = req.nextUrl.searchParams.get('search') || '';
  const status = req.nextUrl.searchParams.get('status') || '';

  let where = '1=1';
  const params: any[] = [];
  if (search) { where += ' AND email LIKE ?'; params.push(`%${search}%`); }
  if (status === 'available') { where += " AND banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"; }
  else if (status === 'banned') { where += ' AND banned = 1'; }
  else if (status === 'allocated') { where += ' AND allocatedTo IS NOT NULL'; }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM outlook_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM outlook_accounts WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { accounts = [] } = await req.json();

  const stmt = db.prepare(`INSERT OR IGNORE INTO outlook_accounts (id, email, password, clientId, refreshToken, addedAt) VALUES (?, ?, ?, ?, ?, ?)`);
  let imported = 0;
  const now = new Date().toISOString();
  for (const acc of accounts) {
    const id = `outlook_${Date.now()}_${imported}`;
    const r = stmt.run(id, acc.email, acc.password, acc.clientId, acc.refreshToken, now);
    if (r.changes > 0) imported++;
  }
  return NextResponse.json({ imported });
}
