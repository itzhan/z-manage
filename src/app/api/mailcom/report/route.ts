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
      switch (r.result) {
        case 'used':
          db.prepare("UPDATE mailcom_accounts SET tokenStatus = 'used', allocatedTo = NULL, allocatedAt = NULL WHERE email = ?").run(r.email);
          break;
        case 'banned':
          db.prepare('UPDATE mailcom_accounts SET banned = 1, mailBannedAt = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?')
            .run(new Date().toISOString(), r.email);
          break;
        case 'token_failed':
          db.prepare("UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?")
            .run(r.error ?? null, r.email);
          break;
        default:
          continue;
      }
      updated++;
    }
    return updated;
  });

  return NextResponse.json({ updated: tx() });
}
