import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const count = (where = '1=1') =>
    (db.prepare(`SELECT COUNT(*) as c FROM openai_pool WHERE ${where}`).get() as any).c;

  return NextResponse.json({
    total: count(),
    available: count("used = 0 AND allocatedTo IS NULL AND msRefreshToken IS NOT NULL"),
    used: count("used = 1"),
    allocated: count("allocatedTo IS NOT NULL"),
  });
}
