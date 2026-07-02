import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function PUT(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { emails, exported } = await req.json() as { emails: string[]; exported: boolean };
  if (!emails || !Array.isArray(emails)) return NextResponse.json({ error: 'emails required' }, { status: 400 });
  const placeholders = emails.map(() => '?').join(',');
  const now = new Date().toISOString();
  if (exported) {
    db.prepare(`UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`).run(now, ...emails);
  } else {
    db.prepare(`UPDATE registered_accounts SET exported = 0, exportedAt = NULL WHERE email IN (${placeholders})`).run(...emails);
  }
  return NextResponse.json({ updated: emails.length });
}
