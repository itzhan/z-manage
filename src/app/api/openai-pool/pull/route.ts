import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const count = Math.min(body.count ?? 1, 50);
  const machineId = body.machineId || a.keyName!;
  const now = new Date().toISOString();

  const db = getDb();
  const items = db.prepare(
    `SELECT * FROM openai_pool WHERE used = 0 AND allocatedTo IS NULL AND msRefreshToken IS NOT NULL ORDER BY addedAt ASC LIMIT ?`
  ).all(count) as any[];

  if (items.length === 0) {
    return NextResponse.json({ items: [], message: '没有可用的 OpenAI 账号' });
  }

  const ids = items.map((r: any) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE openai_pool SET allocatedTo = ?, allocatedAt = ? WHERE id IN (${placeholders})`).run(machineId, now, ...ids);

  logAllocation(db, 'openai-pool', 'pull', a.keyName!, items.length, { machineId, emails: items.map((r: any) => r.email) });

  return NextResponse.json({ items });
}
