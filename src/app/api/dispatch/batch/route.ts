import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const { action, count = 1, params: taskParams, workerIds, batchSize: rawBatchSize } = body;

  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 });
  if (count < 1 || count > 500) return NextResponse.json({ error: 'count must be 1-500' }, { status: 400 });

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
    return NextResponse.json({ error: '没有可用的在线 Worker', created: 0, dispatched: 0, failed: 0 }, { status: 503 });
  }

  // Calculate capacity-weighted allocation
  const available = workers.filter(w => (w.runningTasks ?? 0) < w.maxTasks);
  if (available.length === 0) {
    return NextResponse.json({ error: '所有 Worker 已满', created: 0, dispatched: 0, failed: count }, { status: 503 });
  }

  // Build dispatch queue
  const dispatchQueue: any[] = [];
  if (preferredSet.size > 0) {
    const preferred = available.filter(w => preferredSet.has(w.id));
    const rest = available.filter(w => !preferredSet.has(w.id));
    let remaining = count;
    for (const w of preferred) {
      const c = w.maxTasks - (w.runningTasks ?? 0);
      const n = Math.min(c, remaining);
      for (let j = 0; j < n; j++) dispatchQueue.push(w);
      remaining -= n;
    }
    if (remaining > 0) {
      const totalCap = rest.reduce((s: number, w: any) => s + (w.maxTasks - (w.runningTasks ?? 0)), 0);
      if (totalCap > 0) {
        for (const w of rest) {
          const c = w.maxTasks - (w.runningTasks ?? 0);
          const n = Math.min(c, Math.round(remaining * c / totalCap));
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
    const totalCap = available.reduce((s: number, w: any) => s + (w.maxTasks - (w.runningTasks ?? 0)), 0);
    let remaining = count;
    const assigned = new Map<string, number>();
    for (const w of available) {
      const c = w.maxTasks - (w.runningTasks ?? 0);
      const n = Math.min(c, Math.floor(count * c / totalCap));
      assigned.set(w.id, n);
      remaining -= n;
    }
    const sorted = [...available].sort((a2, b2) => {
      const aCap = (a2.maxTasks - (a2.runningTasks ?? 0)) - (assigned.get(a2.id) ?? 0);
      const bCap = (b2.maxTasks - (b2.runningTasks ?? 0)) - (assigned.get(b2.id) ?? 0);
      return bCap - aCap;
    });
    for (const w of sorted) {
      if (remaining <= 0) break;
      const c = (w.maxTasks - (w.runningTasks ?? 0)) - (assigned.get(w.id) ?? 0);
      if (c > 0) { assigned.set(w.id, (assigned.get(w.id) ?? 0) + 1); remaining--; }
    }
    for (const w of available) {
      const n = assigned.get(w.id) ?? 0;
      for (let j = 0; j < n; j++) dispatchQueue.push(w);
    }
  }

  while (dispatchQueue.length > count) dispatchQueue.pop();

  const batchSize = rawBatchSize && rawBatchSize > 0 ? rawBatchSize : count;

  // Stream response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const totalBatches = Math.ceil(count / batchSize);
      let globalDispatched = 0;
      let globalFailed = 0;
      const allTaskIds: string[] = [];

      send({ type: 'start', total: count, batchSize, batches: totalBatches });

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchStart = batchIdx * batchSize;
        const batchCount = Math.min(batchSize, count - batchStart);

        send({ type: 'batch_start', batch: batchIdx + 1, batches: totalBatches, batchCount });

        // Re-read worker state for each batch
        const freshWorkers = db.prepare(`SELECT * FROM workers WHERE status = 'online' AND capabilities LIKE ? ORDER BY runningTasks ASC`).all(cap) as any[];
        const batchAvailable = freshWorkers.filter(w => (w.runningTasks ?? 0) < w.maxTasks);

        // Build dispatch queue for this batch
        const batchQueue: any[] = [];
        if (batchAvailable.length > 0) {
          const totalCap = batchAvailable.reduce((s: number, w: any) => s + (w.maxTasks - (w.runningTasks ?? 0)), 0);
          let remaining = batchCount;
          const assigned = new Map<string, number>();
          for (const w of batchAvailable) {
            const c = w.maxTasks - (w.runningTasks ?? 0);
            const n = Math.min(c, Math.floor(batchCount * c / totalCap));
            assigned.set(w.id, n);
            remaining -= n;
          }
          const sorted = [...batchAvailable].sort((a2, b2) => ((b2.maxTasks - (b2.runningTasks ?? 0)) - (assigned.get(b2.id) ?? 0)) - ((a2.maxTasks - (a2.runningTasks ?? 0)) - (assigned.get(a2.id) ?? 0)));
          for (const w of sorted) { if (remaining <= 0) break; const c = (w.maxTasks - (w.runningTasks ?? 0)) - (assigned.get(w.id) ?? 0); if (c > 0) { assigned.set(w.id, (assigned.get(w.id) ?? 0) + 1); remaining--; } }
          for (const w of batchAvailable) { const n = assigned.get(w.id) ?? 0; for (let j = 0; j < n; j++) batchQueue.push(w); }
          while (batchQueue.length > batchCount) batchQueue.pop();
        }

        // Dispatch this batch in parallel
        const batchTaskIds: string[] = [];
        const taskItems = batchQueue.map((worker, i) => {
          const taskId = `t_${Date.now()}_${batchStart + i}_${Math.random().toString(36).slice(2, 6)}`;
          db.prepare('INSERT INTO dispatch_tasks (id, workerId, action, status, params, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, worker.id, action, 'pending', JSON.stringify(taskParams || {}), now);
          batchTaskIds.push(taskId);
          allTaskIds.push(taskId);
          return { taskId, worker };
        });

        // Mark shortfall
        const batchShortfall = batchCount - taskItems.length;
        for (let j = 0; j < batchShortfall; j++) {
          const tid = `t_${Date.now()}_sf_${Math.random().toString(36).slice(2, 6)}`;
          db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, errorReason, createdAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, action, 'failed', JSON.stringify(taskParams || {}), '所有 Worker 已满', now, now);
          globalFailed++;
        }

        const CONCURRENCY = 20;
        let idx = 0;
        let batchDispatched = 0;
        let batchFailed = 0;
        const dispatchOne = async () => {
          while (idx < taskItems.length) {
            const i = idx++;
            const { taskId, worker } = taskItems[i];
            for (let attempt = 0; attempt < 3; attempt++) {
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
                batchDispatched++;
                globalDispatched++;
                break;
              } catch (e: any) {
                if (attempt < 2) {
                  await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                } else {
                  db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', `Worker 连接失败: ${e.message}`, new Date().toISOString(), taskId);
                  batchFailed++;
                  globalFailed++;
                }
              }
            }
            send({ type: 'progress', dispatched: globalDispatched, failed: globalFailed, total: count, batch: batchIdx + 1, batches: totalBatches, batchProgress: `${batchDispatched + batchFailed}/${batchCount}` });
        }
      };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, taskItems.length) }, () => dispatchOne()));

        send({ type: 'batch_dispatched', batch: batchIdx + 1, batches: totalBatches, batchDispatched, batchFailed });

        // Wait for 4/5 of this batch to finish before starting next batch
        if (batchIdx < totalBatches - 1 && batchTaskIds.length > 0) {
          const threshold = Math.ceil(batchTaskIds.length * 4 / 5);
          send({ type: 'batch_waiting', batch: batchIdx + 1, threshold, total: batchTaskIds.length });

          const placeholders = batchTaskIds.map(() => '?').join(',');
          for (let wait = 0; wait < 600; wait++) {
            await new Promise(r => setTimeout(r, 5000));
            const finished = (db.prepare(`SELECT COUNT(*) as c FROM dispatch_tasks WHERE id IN (${placeholders}) AND status IN ('success','failed','cancelled')`).get(...batchTaskIds) as any).c;
            send({ type: 'batch_poll', batch: batchIdx + 1, finished, threshold, total: batchTaskIds.length });
            if (finished >= threshold) break;
          }
        }
      }

      logAllocation(db, 'dispatch', 'batch', a.keyName!, count, { action, dispatched: globalDispatched, failed: globalFailed });
      send({ type: 'done', created: count, dispatched: globalDispatched, failed: globalFailed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
