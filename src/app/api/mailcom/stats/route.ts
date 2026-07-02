import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts').get() as any).c;
  const available = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'").get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts WHERE allocatedTo IS NOT NULL').get() as any).c;
  const banned = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts WHERE banned = 1').get() as any).c;
  const tokenFailed = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts WHERE tokenStatus = 'failed'").get() as any).c;

  return NextResponse.json({ total, available, allocated, banned, tokenFailed });
}
