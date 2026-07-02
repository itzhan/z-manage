import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function PUT(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { ids, exported } = await req.json() as { ids: string[]; exported: boolean };
  if (!ids || !Array.isArray(ids)) return NextResponse.json({ error: 'ids required' }, { status: 400 });
  const placeholders = ids.map(() => '?').join(',');
  if (exported) {
    db.prepare(`UPDATE openai_keys SET exported = 1, exportedAt = ? WHERE id IN (${placeholders})`).run(new Date().toISOString(), ...ids);
  } else {
    db.prepare(`UPDATE openai_keys SET exported = 0, exportedAt = NULL WHERE id IN (${placeholders})`).run(...ids);
  }
  return NextResponse.json({ updated: ids.length });
}
