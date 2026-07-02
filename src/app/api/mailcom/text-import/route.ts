import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { text = '' } = await req.json() as { text?: string };
  const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l);

  const accounts: { email: string; password: string }[] = [];
  for (const line of lines) {
    const parts = line.split(/\s*-{2,}\s*/);
    if (parts.length >= 2) {
      // 去掉"卡号："等中文前缀
      let email = parts[0].trim().replace(/^[^\x00-\x7F]+[：:]\s*/, '');
      const password = parts[1].trim();
      if (email && password && email.includes('@')) accounts.push({ email, password });
    }
  }

  if (accounts.length === 0) {
    return NextResponse.json({ imported: 0, accounts: [] });
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, accessToken, refreshToken, sessionExpiresAt, addedAt)
    VALUES (@id, @email, @password, @tokenStatus, @tokenAt, @tokenError, @banned, @mailBannedAt, @mailPaidAt, @accessToken, @refreshToken, @sessionExpiresAt, @addedAt)
  `);

  const importedEmails: string[] = [];

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: `mc_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email, password: a.password,
        tokenStatus: 'pending',
        tokenAt: null, tokenError: null,
        banned: 0, mailBannedAt: null, mailPaidAt: null,
        accessToken: null, refreshToken: null, sessionExpiresAt: null,
        addedAt: new Date().toISOString(),
      });
      importedEmails.push(a.email);
      count++;
    }
    return count;
  });

  const count = tx();

  // Async prelogin (same pattern as /import)
  if (importedEmails.length > 0) {
    (async () => {
      try {
        // @ts-ignore
        const { MailComClient, MemorySessionStore } = await import('@/mailcom-sdk/index.js');
        const dbInner = getDb();
        const accts = dbInner.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${importedEmails.map(() => '?').join(',')})`)
          .all(...importedEmails) as any[];
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

  return NextResponse.json({ imported: count, accounts });
}
