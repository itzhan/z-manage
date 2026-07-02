import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 50, 200);
  const offset = (page - 1) * limit;
  const conditions = ['deleted = 0'];
  const params: any[] = [];
  const status = req.nextUrl.searchParams.get('status');
  if (status === 'available') { conditions.push('bad = 0 AND allocatedTo IS NULL'); }
  else if (status === 'bad') { conditions.push('bad = 1'); }
  const region = req.nextUrl.searchParams.get('region');
  if (region) { conditions.push('region = ?'); params.push(region); }
  const allocatedTo = req.nextUrl.searchParams.get('allocatedTo');
  if (allocatedTo) { conditions.push('allocatedTo = ?'); params.push(allocatedTo); }
  const where = conditions.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) as c FROM proxies WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM proxies WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { proxies = [] } = await req.json();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO proxies (id, host, port, user, pass, region, pool, claudeUsed, claudeCount, openaiCount, openaiInUse, openaiInUseCount, bad, bad_reason, deleted, deletedAt, addedAt)
    VALUES (@id, @host, @port, @user, @pass, @region, @pool, @claudeUsed, @claudeCount, @openaiCount, @openaiInUse, @openaiInUseCount, @bad, @bad_reason, @deleted, @deletedAt, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const p of proxies) {
      stmt.run({
        id: p.id || `proxy_${p.host}_${p.port}`,
        host: p.host, port: String(p.port), user: p.user, pass: p.pass,
        region: p.region ?? 'us', pool: p.pool ?? 'static',
        claudeUsed: (p.claudeUsed || p.claude_used) ? 1 : 0,
        claudeCount: p.claudeCount ?? p.claude_count ?? 0,
        openaiCount: p.openaiCount ?? p.openai_count ?? 0,
        openaiInUse: (p.openaiInUse || p.openai_in_use) ? 1 : 0,
        openaiInUseCount: p.openaiInUseCount ?? p.openai_in_use_count ?? 0,
        bad: p.bad ? 1 : 0, bad_reason: p.bad_reason ?? null,
        deleted: p.deleted ? 1 : 0, deletedAt: p.deletedAt ?? null,
        addedAt: p.addedAt ?? new Date().toISOString(),
      });
      count++;
    }
    return count;
  });

  return NextResponse.json({ imported: tx() });
}
