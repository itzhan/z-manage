import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') || '';
  const workerId = sp.get('workerId') || '';
  const action = sp.get('action') || '';
  const page = Math.max(1, parseInt(sp.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50')));

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (workerId) { conditions.push('workerId = ?'); params.push(workerId); }
  if (action) { conditions.push('action = ?'); params.push(action); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) as c FROM dispatch_tasks ${where}`).get(...params) as any).c;
  const tasks = db.prepare(`SELECT id, workerId, action, status, params, resources, result, errorReason, createdAt, dispatchedAt, finishedAt FROM dispatch_tasks ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);

  return NextResponse.json({ tasks, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const { action, params: taskParams } = body;
  let { workerId } = body;

  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 });

  const db = getDb();
  const now = new Date().toISOString();
  const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  if (workerId === 'auto' || !workerId) {
    const cap = `%"${action}"%`;
    const worker = db.prepare(`SELECT * FROM workers WHERE status = 'online' AND runningTasks < maxTasks AND capabilities LIKE ? ORDER BY runningTasks ASC LIMIT 1`).get(cap) as any;
    if (!worker) {
      db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, errorReason, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, action, 'failed', JSON.stringify(taskParams || {}), '没有可用的 Worker', now);
      return NextResponse.json({ error: '没有可用的在线 Worker', task: { id: taskId, status: 'failed' } }, { status: 503 });
    }
    workerId = worker.id;
  }

  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as any;
  if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });

  db.prepare('INSERT INTO dispatch_tasks (id, workerId, action, status, params, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, workerId, action, 'pending', JSON.stringify(taskParams || {}), now);

  const masterUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  const apiKey = req.headers.get('x-api-key') || req.nextUrl.searchParams.get('_key') || '';

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

    db.prepare('UPDATE dispatch_tasks SET status = ?, dispatchedAt = ? WHERE id = ?').run('dispatching', now, taskId);
    db.prepare('UPDATE workers SET runningTasks = runningTasks + 1 WHERE id = ?').run(workerId);
    logAllocation(db, 'dispatch', 'create', a.keyName!, 1, { taskId, action, workerId });
  } catch (e: any) {
    db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', `Worker 连接失败: ${e.message}`, now, taskId);
  }

  const task = db.prepare('SELECT * FROM dispatch_tasks WHERE id = ?').get(taskId);
  return NextResponse.json(task);
}
