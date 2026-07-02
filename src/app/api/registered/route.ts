import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 20, 200);
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: any[] = [];
  const status = req.nextUrl.searchParams.get('status');
  if (status) { conditions.push('status = ?'); params.push(status); }
  const sourceKeyName = req.nextUrl.searchParams.get('sourceKeyName');
  if (sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(sourceKeyName); }
  const exported = req.nextUrl.searchParams.get('exported');
  if (exported === '1') { conditions.push('exported = 1'); }
  else if (exported === '0') { conditions.push('(exported = 0 OR exported IS NULL)'); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM registered_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM registered_accounts WHERE ${where} ORDER BY uploadedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { accounts = [] } = await req.json();
  const now = new Date().toISOString();
  const sourceKeyName = a.keyName || '未知';

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO registered_accounts (
      email, status, plan_type, session_key, platform,
      registered_at, paid_at, authorized_at,
      paid_card, paid_card_brand, proxy_host,
      google_email, browser_id, sourceKeyName, uploadedAt
    ) VALUES (
      @email, @status, @plan_type, @session_key, @platform,
      @registered_at, @paid_at, @authorized_at,
      @paid_card, @paid_card_brand, @proxy_host,
      @google_email, @browser_id, @sourceKeyName, @uploadedAt
    )
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        email: a.email,
        status: a.status ?? 'registered',
        plan_type: a.plan_type ?? null,
        session_key: a.session_key ?? null,
        platform: a.platform ?? null,
        registered_at: a.registered_at ?? null,
        paid_at: a.paid_at ?? null,
        authorized_at: a.authorized_at ?? null,
        paid_card: a.paid_card ?? null,
        paid_card_brand: a.paid_card_brand ?? null,
        proxy_host: a.proxy_host ?? null,
        google_email: a.google_email ?? null,
        browser_id: a.browser_id ?? null,
        sourceKeyName,
        uploadedAt: now,
      });
      count++;
    }
    return count;
  });

  const imported = tx();
  logAllocation(db, 'registered_accounts', 'upload', sourceKeyName, imported);
  return NextResponse.json({ imported });
}
