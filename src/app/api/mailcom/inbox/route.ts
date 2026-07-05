import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

async function loadSdk() {
  // @ts-ignore - dynamic ESM import
  return await import('@/mailcom-sdk/index.js');
}

async function createClient(sdk: any, account: any, db: any) {
  const { MailComClient, MemorySessionStore } = sdk;
  const store = new MemorySessionStore();

  if (account.accessToken) {
    await store.save(account.email, {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      accountEmail: account.email,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(account.sessionExpiresAt ? { expiresAt: new Date(account.sessionExpiresAt).getTime() } : {}),
    });
  }

  const client = new MailComClient({ email: account.email, password: account.password, sessionStore: store });
  await client.auth.login();

  const session = (client as any).session;
  if (session?.accessToken) {
    db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ?, tokenError = NULL WHERE email = ?`)
      .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, new Date().toISOString(), account.email);
  }

  return client;
}

async function readMails(client: any, mailId?: string) {
  if (mailId) {
    const body = await client.mail.getBody(mailId, { format: 'html', markRead: false });
    return { body };
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
    return { mails };
  }
}

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const email = req.nextUrl.searchParams.get('email');
  const mailId = req.nextUrl.searchParams.get('mailId') || undefined;
  if (!email) return NextResponse.json({ error: 'email query param required' }, { status: 400 });

  const db = getDb();
  const account = db.prepare('SELECT * FROM mailcom_accounts WHERE email = ?').get(email) as any;
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const sdk = await loadSdk();

  // First attempt: use cached token
  try {
    const client = await createClient(sdk, account, db);
    return NextResponse.json(await readMails(client, mailId));
  } catch {
    // Token expired or invalid — clear and retry with fresh login
  }

  // Second attempt: clear token and re-login from scratch
  try {
    db.prepare("UPDATE mailcom_accounts SET accessToken = NULL, refreshToken = NULL, tokenStatus = 'failed' WHERE email = ?").run(email);
    const freshAccount = { ...account, accessToken: null, refreshToken: null };
    const client = await createClient(sdk, freshAccount, db);
    return NextResponse.json(await readMails(client, mailId));
  } catch (err: any) {
    db.prepare("UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?").run(err.message || String(err), email);
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 });
  }
}
