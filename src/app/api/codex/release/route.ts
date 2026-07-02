import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { machineId, ids = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const stmt = db.prepare('UPDATE codex_credentials SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ? AND allocatedTo = ?');
  const tx = db.transaction(() => {
    let released = 0;
    for (const id of ids) {
      released += stmt.run(id, machineId).changes;
    }
    return released;
  });

  return NextResponse.json({ released: tx() });
}
