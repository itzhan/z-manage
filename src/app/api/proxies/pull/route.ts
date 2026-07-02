import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { count = 1, machineId, region, pool, preview } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let query = `SELECT * FROM proxies WHERE bad = 0 AND deleted = 0 AND allocatedTo IS NULL`;
    const params: any[] = [];

    if (region) { query += ` AND region = ?`; params.push(region); }
    if (pool) { query += ` AND pool = ?`; params.push(pool); }

    query += ` ORDER BY addedAt DESC LIMIT ?`;
    params.push(count);

    const rows = db.prepare(query).all(...params) as any[];
    if (rows.length === 0) return { proxies: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE proxies SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      proxies: rows.map(r => ({
        ...r, bad: !!r.bad, deleted: !!r.deleted,
        ...(preview ? {} : { allocatedTo: machineId, allocatedAt: now }),
      })),
    };
  });

  const result = tx();
  if (!preview && result.proxies.length > 0) {
    logAllocation(db, 'proxies', 'pull', a.keyName || '未知', result.proxies.length, {
      pool: pool || '(all)',
      region: region || '(all)',
      count: result.proxies.length,
    });
  }
  return NextResponse.json(result);
}
