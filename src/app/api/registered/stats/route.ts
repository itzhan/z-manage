import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM registered_accounts').get() as any).c;
  const exported = (db.prepare('SELECT COUNT(*) as c FROM registered_accounts WHERE exported = 1').get() as any).c;
  const unexported = total - exported;

  const statusRows = db.prepare('SELECT status, COUNT(*) as c FROM registered_accounts GROUP BY status').all() as any[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status || ''] = r.c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM registered_accounts GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  const platformRows = db.prepare('SELECT platform, COUNT(*) as c FROM registered_accounts GROUP BY platform').all() as any[];
  const byPlatform: Record<string, number> = {};
  for (const r of platformRows) byPlatform[r.platform || ''] = r.c;

  return NextResponse.json({ total, exported, unexported, byStatus, bySource, byPlatform });
}
