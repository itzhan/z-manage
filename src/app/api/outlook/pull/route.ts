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
    const rows = db.prepare(`SELECT * FROM outlook_accounts WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok' ORDER BY addedAt DESC LIMIT ?`).all(count) as any[];
    if (rows.length === 0) return { accounts: [] };
    if (!preview) {
      const stmt = db.prepare('UPDATE outlook_accounts SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) stmt.run(machineId, now, row.id);
    }
    return { accounts: rows };
  });

  const result = txFn.exclusive();
  if (!preview && result.accounts.length > 0) {
    logAllocation(db, 'outlook', 'pull', a.keyName || '未知', result.accounts.length, { count: result.accounts.length });
  }
  return NextResponse.json(result);
}
