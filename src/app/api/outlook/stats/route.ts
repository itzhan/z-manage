import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const count = (t: string, w = '1=1') => (db.prepare(`SELECT COUNT(*) as c FROM outlook_accounts WHERE ${w}`).get() as any).c;
  return NextResponse.json({
    total: count('outlook_accounts'),
    available: count('outlook_accounts', "banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"),
    banned: count('outlook_accounts', 'banned = 1'),
    allocated: count('outlook_accounts', 'allocatedTo IS NOT NULL'),
  });
}
