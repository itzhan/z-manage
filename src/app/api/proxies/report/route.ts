import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const { machineId, reports = [] } = await req.json();
  if (!machineId) return NextResponse.json({ error: 'machineId required' }, { status: 400 });

  const tx = db.transaction(() => {
    let updated = 0;
    for (const r of reports) {
      if (r.result === 'bad') {
        db.prepare('UPDATE proxies SET bad = 1, bad_reason = ?, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
          .run(r.reason ?? null, r.host, String(r.port));
      } else if (r.success) {
        if (r.purpose === 'claude') {
          db.prepare('UPDATE proxies SET claudeUsed = 1, claudeCount = claudeCount + 1, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
            .run(r.host, String(r.port));
        } else if (r.purpose === 'openai') {
          db.prepare('UPDATE proxies SET openaiCount = openaiCount + 1, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
            .run(r.host, String(r.port));
        }
      } else {
        db.prepare('UPDATE proxies SET allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
          .run(r.host, String(r.port));
      }
      updated++;
    }
    return updated;
  });

  return NextResponse.json({ updated: tx() });
}
