import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
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
  const { machineId, reports = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const tx = db.transaction(() => {
    let updated = 0;
    for (const r of reports) {
      const cols = PLATFORM_COLS[r.platform];
      if (!cols) continue;

      if (r.success) {
        // 预占已在 pull 时完成，只需清除 allocatedTo + 重算 status
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(r.cardId) as any;
        if (!card) continue;

        let newStatus = card.status;
        if (card.status !== 'disabled') {
          const allExhausted =
            (card.claudeUsedCount + (r.platform === 'claude' ? 0 : 0)) >= card.claudeMaxUsage &&
            (card.codexUsedCount + (r.platform === 'codex' ? 0 : 0)) >= card.codexMaxUsage;
          newStatus = allExhausted ? 'exhausted' : 'active';
        }

        db.prepare('UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, status = ? WHERE id = ?')
          .run(newStatus, r.cardId);

        if (card.accountId && r.deductBalance) {
          db.prepare('UPDATE payment_accounts SET balance = MAX(0, balance - ?) WHERE id = ?')
            .run(r.deductBalance, card.accountId);
        }
      } else {
        // 失败：回退预占的 usedCount，清除 allocatedTo
        db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, ${cols.used} = MAX(0, ${cols.used} - 1) WHERE id = ?`)
          .run(r.cardId);
      }
      updated++;
    }
    return updated;
  });

  return NextResponse.json({ updated: tx() });
}
