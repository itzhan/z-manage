import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const row = db.prepare('SELECT * FROM addresses WHERE used = 0 ORDER BY RANDOM() LIMIT 1').get() as any;

  if (!row) return NextResponse.json({ address: null, error: '没有可用的免税州地址' });

  db.prepare('UPDATE addresses SET used = 1 WHERE id = ?').run(row.id);

  return NextResponse.json({ address: { address1: row.address1, city: row.city, state: row.state, zip: row.zip } });
}
