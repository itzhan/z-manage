import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { text = '' } = await req.json() as { text?: string };
  const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO google_accounts (id, email, password, recoveryEmail, twoFaSecret, used, captcha, abnormal, abnormal_reason, addedAt)
    VALUES (@id, @email, @password, @recoveryEmail, @twoFaSecret, @used, @captcha, @abnormal, @abnormal_reason, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const line of lines) {
      const parts = line.split(/\s*-{2,}\s*/);
      if (parts.length < 2) continue;

      const email = parts[0].trim();
      const password = parts[1].trim();
      const recoveryEmail = parts[2]?.trim() || null;
      const twoFaSecret = parts[3]?.trim() || null;

      if (!email || !password) continue;

      stmt.run({
        id: `ga_${Date.now()}_${count}`,
        email, password,
        recoveryEmail,
        twoFaSecret,
        used: 0, captcha: 0, abnormal: 0, abnormal_reason: null,
        addedAt: new Date().toISOString(),
      });
      count++;
    }
    return count;
  });

  return NextResponse.json({ imported: tx() });
}
