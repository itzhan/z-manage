import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const emails: string[] = body.emails || [];
  const machineId = body.machineId || a.keyName!;

  if (emails.length === 0) return NextResponse.json({ released: 0 });

  const db = getDb();
  const placeholders = emails.map(() => '?').join(',');
  const result = db.prepare(
    `UPDATE openai_pool SET allocatedTo = NULL, allocatedAt = NULL WHERE email IN (${placeholders}) AND allocatedTo = ?`
  ).run(...emails, machineId);

  logAllocation(db, 'openai-pool', 'release', a.keyName!, result.changes, { machineId, emails });

  return NextResponse.json({ released: result.changes });
}
