import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || '';
  const page = Math.max(1, parseInt(sp.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50')));

  let where = '1=1';
  if (status === 'available') where = 'used = 0';
  else if (status === 'used') where = 'used = 1';

  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) as c FROM addresses WHERE ${where}`).get() as any).c;
  const items = db.prepare(`SELECT * FROM addresses WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);

  return NextResponse.json({ items, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const addresses = body.addresses || body.items || body;
  if (!Array.isArray(addresses)) return NextResponse.json({ error: 'Expected array' }, { status: 400 });

  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT INTO addresses (address1, city, state, zip, used, addedAt) VALUES (?, ?, ?, ?, 0, ?)');
  let imported = 0;
  const tx = db.transaction((items: any[]) => {
    for (const item of items) {
      if (!item.address1 || !item.state) continue;
      stmt.run(item.address1, item.city || '', item.state, item.zip || '', now);
      imported++;
    }
  });
  tx(addresses);

  return NextResponse.json({ imported });
}
