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
  const allocatedTo = req.nextUrl.searchParams.get('allocatedTo');
  if (status === 'available') { conditions.push("banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"); }
  else if (status === 'banned') { conditions.push('banned = 1'); }
  else if (status === 'failed') { conditions.push("tokenStatus = 'failed'"); }
  else if (status === 'pending') { conditions.push("tokenStatus = 'pending'"); }
  else if (status === 'used') { conditions.push("allocatedTo IS NOT NULL"); }
  else if (status === 'allocated') { conditions.push("allocatedTo IS NOT NULL"); }
  if (allocatedTo) { conditions.push('allocatedTo = ?'); params.push(allocatedTo); }
  const search = req.nextUrl.searchParams.get('search');
  if (search) { conditions.push('email LIKE ?'); params.push(`%${search}%`); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM mailcom_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM mailcom_accounts WHERE ${where} ORDER BY CASE WHEN banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok' THEN 0 WHEN tokenStatus = 'ok' THEN 1 WHEN tokenStatus = 'pending' THEN 2 ELSE 3 END, addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { accounts = [] } = await req.json();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, accessToken, refreshToken, sessionExpiresAt, addedAt)
    VALUES (@id, @email, @password, @tokenStatus, @tokenAt, @tokenError, @banned, @mailBannedAt, @mailPaidAt, @accessToken, @refreshToken, @sessionExpiresAt, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    const importedEmails: string[] = [];
    for (const a of accounts) {
      stmt.run({
        id: a.id || `mc_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email, password: a.password,
        tokenStatus: a.tokenStatus ?? 'ok',
        tokenAt: a.tokenAt ?? null,
        tokenError: a.tokenError ?? null,
        banned: a.banned ? 1 : 0,
        mailBannedAt: a.mailBannedAt ?? null,
        mailPaidAt: a.mailPaidAt ?? null,
        accessToken: a.accessToken ?? null,
        refreshToken: a.refreshToken ?? null,
        sessionExpiresAt: a.sessionExpiresAt ?? null,
        addedAt: a.addedAt ?? new Date().toISOString(),
      });
      if (!a.accessToken) importedEmails.push(a.email);
      count++;
    }
    return { count, importedEmails };
  });

  const result = tx();

  // 异步 prelogin（不阻塞响应）
  if (result.importedEmails.length > 0) {
    (async () => {
      try {
        // @ts-ignore
        const { MailComClient, MemorySessionStore } = await import('@/mailcom-sdk/index.js');
        const dbInner = getDb();
        const accts = dbInner.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${result.importedEmails.map(() => '?').join(',')})`)
          .all(...result.importedEmails) as any[];
        for (const row of accts) {
          try {
            const store = new MemorySessionStore();
            const client = new MailComClient({ email: row.email, password: row.password, sessionStore: store });
            const session = await client.auth.login();
            dbInner.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
            // @ts-ignore
              .run(session!.accessToken, session!.refreshToken, session!.expiresAt ? new Date(session!.expiresAt).toISOString() : null, new Date().toISOString(), row.email);
          } catch (e: any) {
            dbInner.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`).run(e.message || String(e), row.email);
          }
        }
      } catch { /* ignore */ }
    })();
  }

  return NextResponse.json({ imported: result.count });
}
