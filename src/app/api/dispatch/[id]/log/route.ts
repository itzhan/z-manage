import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const db = getDb();
  const task = db.prepare('SELECT log, status FROM dispatch_tasks WHERE id = ?').get(id) as any;
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  return NextResponse.json({ log: task.log || '', status: task.status });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const body = await req.json();
  if (!body.text) return NextResponse.json({ ok: true });

  const db = getDb();
  db.prepare('UPDATE dispatch_tasks SET log = COALESCE(log, \'\') || ? WHERE id = ?').run(body.text, id);
  return NextResponse.json({ ok: true });
}
