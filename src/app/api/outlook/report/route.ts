import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { machineId, reports = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  let updated = 0;
  for (const r of reports) {
    if (r.banned) {
      db.prepare('UPDATE outlook_accounts SET banned = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
    } else {
      db.prepare('UPDATE outlook_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ? AND allocatedTo = ?').run(r.email, machineId);
    }
    updated++;
  }
  return NextResponse.json({ updated });
}
