import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM openai_keys').get() as any).c;
  const exported = (db.prepare('SELECT COUNT(*) as c FROM openai_keys WHERE exported = 1').get() as any).c;
  const unexported = total - exported;
  const active = (db.prepare("SELECT COUNT(*) as c FROM openai_keys WHERE status = 'active'").get() as any).c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM openai_keys GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  return NextResponse.json({ total, exported, unexported, active, bySource });
}
