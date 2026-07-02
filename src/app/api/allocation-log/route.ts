import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 20, 200);
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as c FROM allocation_log').get() as any).c;
  const data = db.prepare('SELECT * FROM allocation_log ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(limit, offset);

  return NextResponse.json({ data, total, page, limit });
}
