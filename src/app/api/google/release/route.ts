import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { machineId, emails = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const stmt = db.prepare('UPDATE google_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ? AND allocatedTo = ?');
  const tx = db.transaction(() => {
    let released = 0;
    for (const email of emails) {
      released += stmt.run(email, machineId).changes;
    }
    return released;
  });

  return NextResponse.json({ released: tx() });
}
