import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM google_accounts').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE allocatedTo IS NOT NULL').get() as any).c;
  const used = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE used = 1').get() as any).c;
  const captcha = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE captcha = 1').get() as any).c;
  const abnormal = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE abnormal = 1').get() as any).c;
  const with2fa = (db.prepare("SELECT COUNT(*) as c FROM google_accounts WHERE used = 0 AND captcha = 0 AND abnormal = 0 AND twoFaSecret IS NOT NULL AND twoFaSecret != ''").get() as any).c;

  return NextResponse.json({ total, available, allocated, used, captcha, abnormal, availableWith2fa: with2fa });
}
