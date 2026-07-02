import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND bad = 0 AND allocatedTo IS NULL').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND allocatedTo IS NOT NULL').get() as any).c;
  const bad = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE bad = 1').get() as any).c;
  const claudeAvailable = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND bad = 0 AND claudeUsed = 0 AND allocatedTo IS NULL').get() as any).c;

  const byRegion = db.prepare(`
    SELECT region, COUNT(*) as total,
      SUM(CASE WHEN bad = 0 AND deleted = 0 AND allocatedTo IS NULL THEN 1 ELSE 0 END) as available
    FROM proxies WHERE deleted = 0 GROUP BY region
  `).all() as any[];

  const regions: Record<string, any> = {};
  for (const r of byRegion) {
    regions[r.region || 'unknown'] = { total: r.total, available: r.available };
  }

  const byPool = db.prepare(`
    SELECT pool, COUNT(*) as total,
      SUM(CASE WHEN bad = 0 AND deleted = 0 AND allocatedTo IS NULL THEN 1 ELSE 0 END) as available
    FROM proxies WHERE deleted = 0 GROUP BY pool
  `).all() as any[];

  const pools: Record<string, any> = {};
  for (const p of byPool) {
    pools[p.pool || 'static'] = { total: p.total, available: p.available };
  }

  return NextResponse.json({ total, available, allocated, bad, claudeAvailable, byRegion: regions, byPool: pools });
}
