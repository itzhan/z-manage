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

  const cap = `%"${action}"%`;
  const allWorkers = db.prepare(`SELECT * FROM workers WHERE status = 'online' AND capabilities LIKE ? ORDER BY runningTasks ASC`).all(cap) as any[];

  let workers: any[];
  const preferredSet = new Set(workerIds && workerIds.length > 0 ? workerIds : []);
  if (preferredSet.size > 0) {
    const selected = allWorkers.filter(w => preferredSet.has(w.id));
    const rest = allWorkers.filter(w => !preferredSet.has(w.id));
    workers = [...selected, ...rest];
  } else {
    workers = allWorkers;
  }

  if (workers.length === 0) {
    return NextResponse.json({ error: '没有可用的在线 Worker', created: 0, dispatched: 0, failed: 0, tasks: [] }, { status: 503 });
  }

  const tasks: any[] = [];
  let dispatched = 0;
  let failed = 0;

  // Calculate capacity-weighted allocation
  const available = workers.filter(w => (w.runningTasks ?? 0) < w.maxTasks);
  if (available.length === 0) {
    for (let j = 0; j < count; j++) {
      const tid = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, errorReason, createdAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, action, 'failed', JSON.stringify(taskParams || {}), '所有 Worker 已满', now, now);
      tasks.push(db.prepare('SELECT id, workerId, action, status, errorReason, createdAt FROM dispatch_tasks WHERE id = ?').get(tid));
      failed++;
    }
    logAllocation(db, 'dispatch', 'batch', a.keyName!, count, { action, dispatched, failed });
    return NextResponse.json({ created: count, dispatched, failed, tasks });
  }

  // Build dispatch queue: distribute by available capacity ratio
  const dispatchQueue: any[] = [];
  if (preferredSet.size > 0) {
    // Preferred mode: fill preferred workers first, overflow to rest
    const preferred = available.filter(w => preferredSet.has(w.id));
    const rest = available.filter(w => !preferredSet.has(w.id));
    let remaining = count;
    for (const w of preferred) {
      const cap = w.maxTasks - (w.runningTasks ?? 0);
      const n = Math.min(cap, remaining);
      for (let j = 0; j < n; j++) dispatchQueue.push(w);
      remaining -= n;
    }
    if (remaining > 0) {
      const totalCap = rest.reduce((s: number, w: any) => s + (w.maxTasks - (w.runningTasks ?? 0)), 0);
      if (totalCap > 0) {
        for (const w of rest) {
          const cap = w.maxTasks - (w.runningTasks ?? 0);
          const n = Math.min(cap, Math.round(remaining * cap / totalCap));
          for (let j = 0; j < n; j++) dispatchQueue.push(w);
        }
      }
      while (dispatchQueue.length < count) {
        const w = rest.find(w2 => dispatchQueue.filter(q => q.id === w2.id).length < (w2.maxTasks - (w2.runningTasks ?? 0)));
        if (!w) break;
        dispatchQueue.push(w);
      }
    }
  } else {
    // Auto mode: distribute by capacity weight
    const totalCap = available.reduce((s: number, w: any) => s + (w.maxTasks - (w.runningTasks ?? 0)), 0);
    let remaining = count;
    const assigned = new Map<string, number>();
    for (const w of available) {
      const cap = w.maxTasks - (w.runningTasks ?? 0);
      const n = Math.min(cap, Math.floor(count * cap / totalCap));
      assigned.set(w.id, n);
      remaining -= n;
    }
    // Distribute remainder to workers with most remaining capacity
    const sorted = [...available].sort((a2, b2) => {
      const aCap = (a2.maxTasks - (a2.runningTasks ?? 0)) - (assigned.get(a2.id) ?? 0);
      const bCap = (b2.maxTasks - (b2.runningTasks ?? 0)) - (assigned.get(b2.id) ?? 0);
      return bCap - aCap;
    });
    for (const w of sorted) {
      if (remaining <= 0) break;
      const cap = (w.maxTasks - (w.runningTasks ?? 0)) - (assigned.get(w.id) ?? 0);
      if (cap > 0) { assigned.set(w.id, (assigned.get(w.id) ?? 0) + 1); remaining--; }
    }
    for (const w of available) {
      const n = assigned.get(w.id) ?? 0;
      for (let j = 0; j < n; j++) dispatchQueue.push(w);
    }
  }

  // Cap to requested count
  while (dispatchQueue.length > count) dispatchQueue.pop();

  // If we couldn't fill all, mark remainder as failed
  const shortfall = count - dispatchQueue.length;
  for (let j = 0; j < shortfall; j++) {
    const tid = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, errorReason, createdAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, action, 'failed', JSON.stringify(taskParams || {}), '所有 Worker 已满', now, now);
    tasks.push(db.prepare('SELECT id, workerId, action, status, errorReason, createdAt FROM dispatch_tasks WHERE id = ?').get(tid));
    failed++;
  }

  // Dispatch tasks from queue
  for (let i = 0; i < dispatchQueue.length; i++) {
    const worker = dispatchQueue[i];
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
