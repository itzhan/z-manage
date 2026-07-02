import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { text, pool = 'static', region = 'us' } = await req.json();
  if (!text || typeof text !== 'string') return NextResponse.json({ error: 'text is required' }, { status: 400 });

  const lines = text.split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0 && !l.startsWith('#'));

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO proxies (id, host, port, user, pass, region, pool, claudeUsed, claudeCount, openaiCount, openaiInUse, openaiInUseCount, bad, bad_reason, deleted, deletedAt, addedAt)
    VALUES (@id, @host, @port, @user, @pass, @region, @pool, 0, 0, 0, 0, 0, 0, NULL, 0, NULL, @addedAt)
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let count = 0;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 4) continue;
      const [host, port, user, pass] = parts;
      stmt.run({
        id: `proxy_${host}_${port}`,
        host, port, user, pass,
        region, pool, addedAt: now,
      });
      count++;
    }
    return count;
  });

  return NextResponse.json({ imported: tx() });
}
