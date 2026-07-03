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
    query += cols ? ` ORDER BY c.${cols.used} ASC` : ` ORDER BY c.addedAt DESC`;

    const allAvailable = db.prepare(query).all(...params) as any[];

    if (noAllocate && cols) {
      // Worker 模式：一张卡可以用多次，按剩余次数展开分配
      const assigned: any[] = [];
      const cardUsageInc: Record<string, number> = {};

      for (let i = 0; i < count; i++) {
        // 找剩余次数最多的卡（考虑本批已分配的次数）
        let best: any = null;
        let bestRemain = 0;
        for (const card of allAvailable) {
          const used = (card[cols.used] ?? 0) + (cardUsageInc[card.id] ?? 0);
          const max = card[cols.max] ?? 1;
          const remain = max - used;
          if (remain > 0 && remain > bestRemain) {
            best = card;
            bestRemain = remain;
          }
        }
        if (!best) break;
        assigned.push({ ...best, deleted: !!best.deleted });
        cardUsageInc[best.id] = (cardUsageInc[best.id] ?? 0) + 1;
      }

      if (!preview) {
        for (const [cardId, inc] of Object.entries(cardUsageInc)) {
          db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ?, ${cols.used} = ${cols.used} + ? WHERE id = ?`).run(machineId, now, inc, cardId);
        }
      }

      const accountIds = [...new Set(assigned.map(r => r.accountId).filter(Boolean))];
      let accounts: any[] = [];
      if (accountIds.length > 0) {
        const ph = accountIds.map(() => '?').join(',');
        accounts = db.prepare(`SELECT * FROM payment_accounts WHERE id IN (${ph})`).all(...accountIds) as any[];
      }

      return { cards: assigned, paymentAccounts: accounts };
    }

    // 本地分配模式（allocatedTo）
    const rows = allAvailable.slice(0, count);
    if (rows.length === 0) return { cards: [], paymentAccounts: [] };

    if (!preview) {
      if (cols) {
        const stmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ?, ${cols.used} = ${cols.used} + 1 WHERE id = ?`);
        for (const row of rows) stmt.run(machineId, now, row.id);
      } else {
        const stmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ? WHERE id = ?`);
        for (const row of rows) stmt.run(machineId, now, row.id);
      }
    }

    const accountIds = [...new Set(rows.map(r => r.accountId).filter(Boolean))];
    let accounts: any[] = [];
    if (accountIds.length > 0) {
      const ph = accountIds.map(() => '?').join(',');
      accounts = db.prepare(`SELECT * FROM payment_accounts WHERE id IN (${ph})`).all(...accountIds) as any[];
    }

    return {
      cards: rows.map(r => ({
        ...r,
        ...(preview ? {} : cols ? { [cols.used]: (r[cols.used] ?? 0) + 1, allocatedTo: machineId, allocatedAt: now } : { allocatedTo: machineId, allocatedAt: now }),
        deleted: !!r.deleted,
      })),
      paymentAccounts: accounts,
    };
  });

  const result = tx();
  if (!preview && result.cards.length > 0) {
    logAllocation(db, 'cards', 'pull', a.keyName || '未知', result.cards.length, {
      brand: brand || '(all)', platform: platform || '(none)', count: result.cards.length,
    });
  }
  return NextResponse.json(result);
}
