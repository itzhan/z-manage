import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { text } = await req.json();
  if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });

  const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
  const stmt = db.prepare(`INSERT OR IGNORE INTO outlook_accounts (id, email, password, clientId, refreshToken, addedAt) VALUES (?, ?, ?, ?, ?, ?)`);
  let imported = 0;
  const now = new Date().toISOString();

  for (const line of lines) {
    // Format: email----password----clientId----refreshToken
    const parts = line.split('----');
    if (parts.length < 4) continue;
    const [email, password, clientId, refreshToken] = parts;
    if (!email || !refreshToken) continue;
    const id = `outlook_${Date.now()}_${imported}`;
    const r = stmt.run(id, email.trim(), password.trim(), clientId.trim(), refreshToken.trim(), now);
    if (r.changes > 0) imported++;
  }
  return NextResponse.json({ imported });
}
