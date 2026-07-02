import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  try {
    const email = req.nextUrl.searchParams.get('email');
    const mailId = req.nextUrl.searchParams.get('mailId') || undefined;
    if (!email) return NextResponse.json({ error: 'email query param required' }, { status: 400 });

    const db = getDb();
    const account = db.prepare('SELECT * FROM mailcom_accounts WHERE email = ?').get(email) as any;
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    // @ts-ignore - dynamic ESM import
    const { MailComClient, MemorySessionStore } = await import('@/mailcom-sdk/index.js');
    const store = new MemorySessionStore();

    // Pre-load cached session if available
    if (account.accessToken) {
      await store.save(email, {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountEmail: email,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(account.sessionExpiresAt ? { expiresAt: new Date(account.sessionExpiresAt).getTime() } : {}),
      });
    }

    const client = new MailComClient({ email: account.email, password: account.password, sessionStore: store });
    await client.auth.login();

    // Update tokens in DB after login (may have been refreshed)
    const session = (client as any).session;
    if (session?.accessToken) {
      db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
        .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, new Date().toISOString(), email);
    }

    if (mailId) {
      const body = await client.mail.getBody(mailId, { format: 'html', markRead: false });
      return NextResponse.json({ body });
    } else {
      const result = await client.mail.listIncoming({ amount: 30 });
      const mails = (result.mail ?? []).map((m: any) => ({
        id: m.attribute?.mailIdentifier ?? m.mailURI,
        from: m.mailHeader?.from,
        to: m.mailHeader?.to,
        subject: m.mailHeader?.subject,
        date: m.mailHeader?.date,
        read: m.attribute?.read,
        folder: m.sourceFolder?.folderName ?? m.sourceFolder?.folderType,
      }));
      return NextResponse.json({ mails });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
