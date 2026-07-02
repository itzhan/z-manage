import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const rows = db.prepare("SELECT tokenStatus, COUNT(*) as c FROM mailcom_accounts GROUP BY tokenStatus").all() as any[];
  const total = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts").get() as any).c;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tokenStatus ?? 'noToken'] = r.c;
  return NextResponse.json({
    total,
    ok: counts['ok'] ?? 0,
    failed: counts['failed'] ?? 0,
    pending: counts['pending'] ?? 0,
    noToken: counts['noToken'] ?? 0,
  });
}
