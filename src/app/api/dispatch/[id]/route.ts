import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const db = getDb();
  const task = db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?').get(id);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  return NextResponse.json(task);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { id } = await ctx.params;
  const body = await req.json();
  const db = getDb();

  const task = db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?').get(id) as any;
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const now = new Date().toISOString();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.status) {
    sets.push('status = ?');
    vals.push(body.status);
    if (['success', 'failed', 'cancelled'].includes(body.status) && !task.finishedAt) {
      sets.push('finishedAt = ?');
      vals.push(now);
      if (task.workerId && ['dispatching', 'running'].includes(task.status)) {
        db.prepare('UPDATE workers SET runningTasks = MAX(0, runningTasks - 1) WHERE id = ?').run(task.workerId);
      }
    }
    if (body.status === 'running' && !task.dispatchedAt) {
      sets.push('dispatchedAt = ?');
      vals.push(now);
    }
  }
  if (body.result !== undefined) { sets.push('result = ?'); vals.push(typeof body.result === 'string' ? body.result : JSON.stringify(body.result)); }
  if (body.errorReason !== undefined) { sets.push('errorReason = ?'); vals.push(body.errorReason); }
  if (body.resources !== undefined) { sets.push('resources = ?'); vals.push(typeof body.resources === 'string' ? body.resources : JSON.stringify(body.resources)); }

  if (sets.length === 0) return NextResponse.json({ ok: true });

  vals.push(id);
  db.prepare(`UPDATE dispatch_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // Auto-handle failed tasks based on error type
  if (body.status === 'failed' && body.errorReason) {
    try {
      const resources = body.resources ? (typeof body.resources === 'string' ? JSON.parse(body.resources) : body.resources) : (task.resources ? JSON.parse(task.resources) : null);

      if (/封禁|BANNED/i.test(body.errorReason)) {
        // Ban: mark mailcom account as banned
        const email = resources?.mailcomEmail;
        if (email) {
          db.prepare("UPDATE mailcom_accounts SET banned = 1, mailBannedAt = ? WHERE email = ?").run(now, email);
        }
      } else if (/\[NETWORK_ERROR\]/.test(body.errorReason)) {
        // Network error: release email, card and proxy (not their fault)
        const email = resources?.mailcomEmail;
        const cardId = resources?.cardId;
        const proxyId = resources?.proxyId;
        if (email) {
          db.prepare("UPDATE mailcom_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ?").run(email);
        }
        if (cardId) {
          db.prepare("UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ?").run(cardId);
        }
        if (proxyId) {
          db.prepare("UPDATE proxies SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ?").run(proxyId);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  const updated = db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?').get(id);
  return NextResponse.json(updated);
}
