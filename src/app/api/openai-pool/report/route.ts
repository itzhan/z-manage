import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const { email, outcome, machineId } = body;

  if (!email || !outcome) return NextResponse.json({ error: 'email and outcome required' }, { status: 400 });

  const db = getDb();

  if (outcome === 'used') {
    db.prepare('UPDATE openai_pool SET used = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(email);
  } else {
    db.prepare('UPDATE openai_pool SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(email);
  }

  logAllocation(db, 'openai-pool', 'report', a.keyName!, 1, { email, outcome, machineId });

  return NextResponse.json({ ok: true });
}
