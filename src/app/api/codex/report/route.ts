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
      const updates: string[] = ['allocatedTo = NULL', 'allocatedAt = NULL'];
      const params: any[] = [];

      if (r.usedInvites != null) { updates.push('usedInvites = ?'); params.push(r.usedInvites); }
      if (r.invites != null) { updates.push('invites = ?'); params.push(JSON.stringify(r.invites)); }
      if (r.accessToken) { updates.push('accessToken = ?'); params.push(r.accessToken); }
      if (r.expiresAt) { updates.push('expiresAt = ?'); params.push(r.expiresAt); }
      if (r.refreshedAt) { updates.push('refreshedAt = ?'); params.push(r.refreshedAt); }

      params.push(r.id);
      db.prepare(`UPDATE codex_credentials SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      updated++;
    }
    return updated;
  });

  return NextResponse.json({ updated: tx() });
}
