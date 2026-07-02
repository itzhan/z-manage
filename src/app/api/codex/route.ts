import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 50, 200);
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: any[] = [];
  const status = req.nextUrl.searchParams.get('status');
  if (status === 'available') { conditions.push('allocatedTo IS NULL AND usedInvites < maxInvites'); }
  else if (status === 'exhausted') { conditions.push('usedInvites >= maxInvites'); }
  const allocatedTo = req.nextUrl.searchParams.get('allocatedTo');
  if (allocatedTo) { conditions.push('allocatedTo = ?'); params.push(allocatedTo); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM codex_credentials WHERE ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM codex_credentials WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  const data = rows.map(r => ({ ...r, invites: JSON.parse(r.invites || '[]') }));
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { credentials = [] } = await req.json();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO codex_credentials (
      id, email, accessToken, chatgptAccountId, expiresAt, planType,
      sourceAccountId, sourceTemplateId, sourceTemplateName,
      usedInvites, maxInvites, invites, subscriptionExpiresAt, addedAt, refreshedAt
    ) VALUES (
      @id, @email, @accessToken, @chatgptAccountId, @expiresAt, @planType,
      @sourceAccountId, @sourceTemplateId, @sourceTemplateName,
      @usedInvites, @maxInvites, @invites, @subscriptionExpiresAt, @addedAt, @refreshedAt
    )
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const c of credentials) {
      stmt.run({
        id: c.id || `cx_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: c.email, accessToken: c.accessToken,
        chatgptAccountId: c.chatgptAccountId ?? null,
        expiresAt: c.expiresAt ?? null,
        planType: c.planType ?? null,
        sourceAccountId: c.sourceAccountId ?? null,
        sourceTemplateId: c.sourceTemplateId ?? null,
        sourceTemplateName: c.sourceTemplateName ?? null,
        usedInvites: c.usedInvites ?? 0,
        maxInvites: c.maxInvites ?? 3,
        invites: JSON.stringify(c.invites ?? []),
        subscriptionExpiresAt: c.subscriptionExpiresAt ?? null,
        addedAt: c.addedAt ?? new Date().toISOString(),
        refreshedAt: c.refreshedAt ?? null,
      });
      count++;
    }
    return count;
  });

  return NextResponse.json({ imported: tx() });
}
