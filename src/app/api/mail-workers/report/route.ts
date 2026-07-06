import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

// POST: Worker 上报注册成功的 mail.com 账号
export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const batch: { email: string; password: string }[] = body.batch ?? [];
  const source: string = body.source ?? 'worker';

  if (batch.length === 0) {
    return NextResponse.json({ error: 'empty batch' }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO mailcom_accounts (id, email, password, used, banned, source, tokenStatus, addedAt)
    VALUES (?, ?, ?, 0, 0, ?, 'pending', ?)
    ON CONFLICT(email) DO NOTHING
  `);

  let added = 0;
  const tx = db.transaction(() => {
    for (const item of batch) {
      if (!item.email || !item.password) continue;
      const email = item.email.trim().toLowerCase();
      const id = `mc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const info = stmt.run(id, email, item.password.trim(), source, now);
      if (info.changes > 0) added++;
    }
  });
  tx();

  if (added > 0) {
    logAllocation(db, 'mailcom', 'worker-report', source, added, { emails: batch.map((b) => b.email) });
  }

  const total = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts').get() as any).c;
  return NextResponse.json({ added, total }, { status: 201 });
}
