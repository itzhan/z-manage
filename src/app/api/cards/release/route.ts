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
  const { machineId, cardIds = [], platform = 'claude' } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const cols = PLATFORM_COLS[platform];

  const tx = db.transaction(() => {
    let released = 0;
    const stmt = cols
      ? db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, ${cols.used} = MAX(0, ${cols.used} - 1) WHERE id = ? AND allocatedTo = ?`)
      : db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ? AND allocatedTo = ?`);
    for (const id of cardIds) {
      const r = stmt.run(id, machineId);
      released += r.changes;
    }
    return released;
  });

  return NextResponse.json({ released: tx() });
}
