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

export async function PUT(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const body = await req.json();
  const db = getDb();

  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as any;
  if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.status !== undefined) { sets.push('status = ?'); vals.push(body.status); }
  if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
  if (body.maxTasks !== undefined) { sets.push('maxTasks = ?'); vals.push(body.maxTasks); }

  if (sets.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  const updated = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  return NextResponse.json(updated);
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
