import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';
import { refreshOutlookToken, readOutlookInbox, readOutlookMailBody } from '@/lib/outlook';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const email = req.nextUrl.searchParams.get('email');
  const mailId = req.nextUrl.searchParams.get('mailId');
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });

  const db = getDb();
  const account = db.prepare('SELECT * FROM outlook_accounts WHERE email = ?').get(email) as any;
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  try {
    let accessToken = account.accessToken;

    // Refresh token if needed
    if (!accessToken) {
      const tokens = await refreshOutlookToken(account.clientId, account.refreshToken);
      accessToken = tokens.accessToken;
      db.prepare('UPDATE outlook_accounts SET accessToken = ?, refreshToken = ?, tokenStatus = ?, tokenAt = ? WHERE email = ?')
        .run(tokens.accessToken, tokens.refreshToken, 'ok', new Date().toISOString(), email);
    }

    if (mailId) {
      const body = await readOutlookMailBody(accessToken, mailId);
      return NextResponse.json({ body });
    } else {
      const mails = await readOutlookInbox(accessToken);
      return NextResponse.json({ mails });
    }
  } catch (err: any) {
    // Token might be expired, try refresh
    try {
      const tokens = await refreshOutlookToken(account.clientId, account.refreshToken);
      db.prepare('UPDATE outlook_accounts SET accessToken = ?, refreshToken = ?, tokenStatus = ?, tokenAt = ? WHERE email = ?')
        .run(tokens.accessToken, tokens.refreshToken, 'ok', new Date().toISOString(), email);

      if (mailId) {
        const body = await readOutlookMailBody(tokens.accessToken, mailId);
        return NextResponse.json({ body });
      } else {
        const mails = await readOutlookInbox(tokens.accessToken);
        return NextResponse.json({ mails });
      }
    } catch (e2: any) {
      db.prepare("UPDATE outlook_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?").run(e2.message, email);
      return NextResponse.json({ error: e2.message }, { status: 500 });
    }
  }
}
