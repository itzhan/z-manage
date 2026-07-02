import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const text: string = body.text || '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO openai_pool (id, email, password, msRefreshToken, addedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password = COALESCE(excluded.password, openai_pool.password),
      msRefreshToken = COALESCE(excluded.msRefreshToken, openai_pool.msRefreshToken)
  `);

  let imported = 0;
  let skipped = 0;

  const insert = db.transaction((rows: string[]) => {
    for (const line of rows) {
      const parts = line.split(/----|\t|---/).map(s => s.trim());
      if (parts.length < 1 || !parts[0].includes('@')) { skipped++; continue; }
      const [email, password, msRefreshToken] = parts;
      stmt.run(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, email.toLowerCase(), password || null, msRefreshToken || null, now);
      imported++;
    }
  });
  insert(lines);

  return NextResponse.json({ imported, skipped });
}
