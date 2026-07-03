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

      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(r.cardId) as any;
      if (!card) continue;

      if (r.success) {
        // 成功：usedCount 已在 pull 时 +1，现在扣余额 + 检查是否耗尽
        if (card.accountId && r.deductBalance) {
          db.prepare('UPDATE payment_accounts SET balance = MAX(0, balance - ?) WHERE id = ?')
            .run(r.deductBalance, card.accountId);
        }

        let newStatus = card.status;
        if (card.status !== 'disabled') {
          const usedAfter = (card[cols.used] ?? 0);
          const maxVal = card[cols.max] ?? 1;
          newStatus = usedAfter >= maxVal ? 'exhausted' : 'active';
        }

        db.prepare('UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, status = ? WHERE id = ?')
          .run(newStatus, r.cardId);

      } else if (r.cardRejected) {
        // 卡被拒/充值失败：标记 disabled
        db.prepare('UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, status = ? WHERE id = ?')
          .run('disabled', r.cardId);

      } else {
        // 其他失败（超时、网络等）：回退 usedCount
        db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, ${cols.used} = MAX(0, ${cols.used} - 1) WHERE id = ?`)
          .run(r.cardId);
      }
      updated++;
    }
    return updated;
  });

  return NextResponse.json({ updated: tx() });
}
