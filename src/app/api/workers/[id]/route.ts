import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const db = getDb();
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  return NextResponse.json(worker);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const db = getDb();

  const now = new Date().toISOString();
  db.prepare(`UPDATE dispatch_tasks SET status = 'cancelled', finishedAt = ? WHERE workerId = ? AND status IN ('pending','dispatching','running')`).run(now, id);
  db.prepare('DELETE FROM workers WHERE id = ?').run(id);

  return NextResponse.json({ ok: true });
}
