import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { machineId, emails = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });
  let released = 0;
  const stmt = db.prepare('UPDATE outlook_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ? AND allocatedTo = ?');
  for (const e of emails) { released += stmt.run(e, machineId).changes; }
  return NextResponse.json({ released });
}
