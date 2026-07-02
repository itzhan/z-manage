import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const { action, count = 1, params: taskParams, workerIds } = body;

  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 });
  if (count < 1 || count > 100) return NextResponse.json({ error: 'count must be 1-100' }, { status: 400 });

  const db = getDb();
  const now = new Date().toISOString();
  const masterUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  const apiKey = req.headers.get('x-api-key') || req.nextUrl.searchParams.get('_key') || '';

  let workers: any[];
  if (workerIds && workerIds.length > 0) {
    const placeholders = workerIds.map(() => '?').join(',');
    workers = db.prepare(`SELECT * FROM workers WHERE id IN (${placeholders}) AND status = 'online'`).all(...workerIds) as any[];
  } else {
    const cap = `%"${action}"%`;
    workers = db.prepare(`SELECT * FROM workers WHERE status = 'online' AND runningTasks < maxTasks AND capabilities LIKE ? ORDER BY runningTasks ASC`).all(cap) as any[];
  }

  if (workers.length === 0) {
    return NextResponse.json({ error: '没有可用的在线 Worker', created: 0, dispatched: 0, failed: 0, tasks: [] }, { status: 503 });
  }

  const tasks: any[] = [];
  let dispatched = 0;
  let failed = 0;

  for (let i = 0; i < count; i++) {
    const worker = workers[i % workers.length];
    const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    db.prepare('INSERT INTO dispatch_tasks (id, workerId, action, status, params, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, worker.id, action, 'pending', JSON.stringify(taskParams || {}), now);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(`${worker.baseUrl}/task/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Token': worker.token || '' },
        body: JSON.stringify({ taskId, action, params: taskParams || {}, masterUrl, masterApiKey: apiKey }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`Worker responded ${resp.status}`);

      db.prepare('UPDATE dispatch_tasks SET status = ?, dispatchedAt = ? WHERE id = ?').run('dispatching', new Date().toISOString(), taskId);
      db.prepare('UPDATE workers SET runningTasks = runningTasks + 1 WHERE id = ?').run(worker.id);
      dispatched++;
    } catch (e: any) {
      db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', `Worker 连接失败: ${e.message}`, new Date().toISOString(), taskId);
      failed++;
    }

    tasks.push(db.prepare('SELECT id, workerId, action, status, errorReason, createdAt FROM dispatch_tasks WHERE id = ?').get(taskId));
  }

  logAllocation(db, 'dispatch', 'batch', a.keyName!, count, { action, dispatched, failed });

  return NextResponse.json({ created: count, dispatched, failed, tasks });
}
