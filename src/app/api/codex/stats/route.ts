import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE allocatedTo IS NULL AND usedInvites < maxInvites').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE allocatedTo IS NOT NULL').get() as any).c;
  const exhausted = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE usedInvites >= maxInvites').get() as any).c;
  const totalInvitesRemaining = (db.prepare('SELECT COALESCE(SUM(maxInvites - usedInvites), 0) as c FROM codex_credentials WHERE usedInvites < maxInvites').get() as any).c;

  return NextResponse.json({ total, available, allocated, exhausted, totalInvitesRemaining });
}
