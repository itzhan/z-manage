import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const body = await req.json();
  const now = new Date().toISOString();
  const db = getDb();

  const result = db.prepare(`
    UPDATE workers SET
      status = 'online',
      lastHeartbeat = ?,
      runningTasks = COALESCE(?, runningTasks),
      systemInfo = COALESCE(?, systemInfo),
      updatedAt = ?
    WHERE id = ?
  `).run(now, body.runningTasks ?? null, body.systemInfo ? JSON.stringify(body.systemInfo) : null, now, id);

  if (result.changes === 0) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
