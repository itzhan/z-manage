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
          db.prepare('UPDATE google_accounts SET used = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
          break;
        case 'captcha':
          db.prepare('UPDATE google_accounts SET used = 1, captcha = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
          break;
        case 'abnormal':
          db.prepare('UPDATE google_accounts SET used = 1, abnormal = 1, abnormal_reason = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.reason ?? null, r.email);
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
