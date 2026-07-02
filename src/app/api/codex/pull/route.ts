import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { count = 1, machineId, minRemainingInvites = 1, preview } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM codex_credentials
      WHERE allocatedTo IS NULL AND (maxInvites - usedInvites) >= ?
      ORDER BY usedInvites ASC
      LIMIT ?
    `).all(minRemainingInvites, count) as any[];

    if (rows.length === 0) return { credentials: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE codex_credentials SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      credentials: rows.map(r => ({
        ...r,
        invites: JSON.parse(r.invites || '[]'),
        ...(preview ? {} : { allocatedTo: machineId, allocatedAt: now }),
      })),
    };
  });

  const result = tx();
  if (!preview && result.credentials.length > 0) {
    logAllocation(db, 'codex', 'pull', a.keyName || '未知', result.credentials.length, {
      emails: result.credentials.map((c: any) => c.email),
      count: result.credentials.length,
    });
  }
  return NextResponse.json(result);
}
