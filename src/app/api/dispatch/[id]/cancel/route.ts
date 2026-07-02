import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const db = getDb();
  const task = db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?').get(id) as any;
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (['success', 'failed', 'cancelled'].includes(task.status)) {
    return NextResponse.json({ error: '任务已结束' }, { status: 400 });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE dispatch_tasks SET status = ?, finishedAt = ? WHERE id = ?').run('cancelled', now, id);

  if (task.workerId && ['dispatching', 'running'].includes(task.status)) {
    db.prepare('UPDATE workers SET runningTasks = MAX(0, runningTasks - 1) WHERE id = ?').run(task.workerId);

    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(task.workerId) as any;
    if (worker) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        await fetch(`${worker.baseUrl}/task/${id}/cancel`, {
          method: 'POST',
          headers: { 'X-Worker-Token': worker.token || '' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
      } catch { /* worker might be offline */ }
    }
  }

  if (task.resources) {
    try {
      const res = JSON.parse(task.resources);
      if (res.mailcomEmail) {
        db.prepare('UPDATE mailcom_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(res.mailcomEmail);
      }
      if (res.openaiEmail) {
        db.prepare('UPDATE openai_pool SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(res.openaiEmail);
      }
      if (res.cardId) {
        db.prepare('UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ?').run(res.cardId);
      }
      if (res.proxyId) {
        db.prepare('UPDATE proxies SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ?').run(res.proxyId);
      }
    } catch { /* ignore parse errors */ }
  }

  return NextResponse.json({ ok: true });
}
