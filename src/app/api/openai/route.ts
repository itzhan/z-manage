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
  const total = (db.prepare(`SELECT COUNT(*) as c FROM openai_keys WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM openai_keys WHERE ${where} ORDER BY uploadedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
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
    INSERT OR REPLACE INTO openai_keys (id, email, apiKey, status, sourceKeyName, uploadedAt)
    VALUES (@id, @email, @apiKey, @status, @sourceKeyName, @uploadedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `ok_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email || '',
        apiKey: a.apiKey || '',
        status: a.status ?? 'active',
        sourceKeyName,
        uploadedAt: now,
      });
      count++;
    }
    return count;
  });

  const imported = tx();
  logAllocation(db, 'openai_keys', 'upload', sourceKeyName, imported);
  return NextResponse.json({ imported });
}
