import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

const PLATFORM_COLS: Record<string, { used: string; max: string }> = {
  claude: { used: 'claudeUsedCount', max: 'claudeMaxUsage' },
  codex: { used: 'codexUsedCount', max: 'codexMaxUsage' },
  claudePlatform: { used: 'claudePlatformUsedCount', max: 'claudePlatformMaxUsage' },
  openaiPlatform: { used: 'openaiPlatformUsedCount', max: 'openaiPlatformMaxUsage' },
};

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { count = 1, machineId, platform, brand, minBalance, preview, noAllocate } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const cols = platform ? PLATFORM_COLS[platform] : null;
  if (platform && !cols) return NextResponse.json({ error: `invalid platform: ${platform}` }, { status: 400 });

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let query = `
      SELECT c.* FROM cards c
      LEFT JOIN payment_accounts pa ON c.accountId = pa.id
      WHERE c.allocatedTo IS NULL AND c.status = 'active' AND c.deleted = 0
    `;
    if (cols) query += ` AND c.${cols.used} < c.${cols.max}`;
    const params: any[] = [];
    if (brand) { query += ` AND c.brand = ?`; params.push(brand); }
    if (minBalance != null) { query += ` AND (pa.balance IS NULL OR pa.balance >= ?)`; params.push(minBalance); }
    query += cols ? ` ORDER BY c.${cols.used} ASC LIMIT ?` : ` ORDER BY c.addedAt DESC LIMIT ?`;
    params.push(count);

    const rows = db.prepare(query).all(...params) as any[];

    if (rows.length === 0) return { cards: [], paymentAccounts: [] };

    if (!preview) {
      if (noAllocate) {
        if (cols) {
          const updateStmt = db.prepare(`UPDATE cards SET ${cols.used} = ${cols.used} + 1 WHERE id = ?`);
          for (const row of rows) updateStmt.run(row.id);
        }
      } else {
        if (cols) {
          const updateStmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ?, ${cols.used} = ${cols.used} + 1 WHERE id = ?`);
          for (const row of rows) updateStmt.run(machineId, now, row.id);
        } else {
          const updateStmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ? WHERE id = ?`);
          for (const row of rows) updateStmt.run(machineId, now, row.id);
        }
      }
    }

    const accountIds = [...new Set(rows.map(r => r.accountId).filter(Boolean))];
    let accounts: any[] = [];
    if (accountIds.length > 0) {
      const placeholders = accountIds.map(() => '?').join(',');
      accounts = db.prepare(`SELECT * FROM payment_accounts WHERE id IN (${placeholders})`).all(...accountIds) as any[];
    }

    if (preview) {
      return { cards: rows.map(r => ({ ...r, deleted: !!r.deleted })), paymentAccounts: accounts };
    }

    const updatedCards = rows.map(r => ({
      ...r,
      ...(cols ? { [cols.used]: (r[cols.used] ?? 0) + 1 } : {}),
      allocatedTo: machineId,
      allocatedAt: now,
      deleted: !!r.deleted,
    }));

    return { cards: updatedCards, paymentAccounts: accounts };
  });

  const result = tx();
  if (!preview && result.cards.length > 0) {
    logAllocation(db, 'cards', 'pull', a.keyName || '未知', result.cards.length, {
      brand: brand || '(all)',
      platform: platform || '(none)',
      count: result.cards.length,
    });
  }
  return NextResponse.json(result);
}
