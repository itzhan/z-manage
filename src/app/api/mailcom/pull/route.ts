import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { count = 1, machineId, preview } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const now = new Date().toISOString();

  const txFn = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM mailcom_accounts
      WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'
      ORDER BY addedAt DESC
      LIMIT ?
    `).all(count) as any[];

    if (rows.length === 0) return { accounts: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE mailcom_accounts SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      accounts: rows.map(r => ({
        ...r, banned: !!r.banned,
        ...(preview ? {} : { allocatedTo: machineId, allocatedAt: now }),
      })),
    };
  });

  const result = txFn.exclusive();
  if (!preview && result.accounts.length > 0) {
    logAllocation(db, 'mailcom', 'pull', a.keyName || '未知', result.accounts.length, {
      emails: result.accounts.map((ac: any) => ac.email),
      count: result.accounts.length,
    });
  }
  return NextResponse.json(result);
}
