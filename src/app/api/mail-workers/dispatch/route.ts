import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

interface MailWorkerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  maxThreads: number;
}

function getWorkers(db: ReturnType<typeof getDb>): MailWorkerRow[] {
  try {
    return db.prepare('SELECT * FROM mail_workers ORDER BY id').all() as MailWorkerRow[];
  } catch {
    return [];
  }
}

function getProxies(db: ReturnType<typeof getDb>): string[] {
  try {
    const rows = db.prepare('SELECT host, port, user, pass FROM proxies WHERE deleted = 0 AND bad = 0').all() as any[];
    return rows.map((r) => `http://${r.user}:${r.pass}@${r.host}:${r.port}`);
  } catch {
    return [];
  }
}

// GET: 查询派活状态 (poll 所有 worker)
export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const workers = getWorkers(db);

  const statuses = await Promise.allSettled(
    workers.map(async (w) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`http://${w.host}:${w.port}/status`, { signal: ctrl.signal });
        clearTimeout(timer);
        return { workerId: w.id, ...(await res.json()) };
      } catch {
        clearTimeout(timer);
        return { workerId: w.id, task: null };
      }
    })
  );

  const results = statuses.map((s) => (s.status === 'fulfilled' ? s.value : null)).filter(Boolean);
  return NextResponse.json({ workers: results });
}

// POST: 派活 — 分配目标到各在线 worker
export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const totalTarget: number = body.target ?? 30;
  const threadsPerWorker: number = body.threads ?? 10;
  const workerIds: string[] | undefined = body.workerIds;

  const db = getDb();
  const allWorkers = getWorkers(db);
  const proxies = getProxies(db);

  if (proxies.length === 0) {
    return NextResponse.json({ error: '代理池为空' }, { status: 400 });
  }

  // 过滤 worker
  const workers = workerIds
    ? allWorkers.filter((w) => workerIds.includes(w.id))
    : allWorkers;

  if (workers.length === 0) {
    return NextResponse.json({ error: '无可用 Worker' }, { status: 400 });
  }

  // 构建 callbackUrl — worker 成功后回报到此
  const masterUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  const apiKey = req.headers.get('x-api-key') || req.nextUrl.searchParams.get('_key') || '';
  const callbackUrl = `${masterUrl}/api/mail-workers/report?_key=${apiKey}`;

  // 均分目标
  const perWorker = Math.ceil(totalTarget / workers.length);
  let remaining = totalTarget;

  const assignments: any[] = [];
  const errors: string[] = [];

  for (const w of workers) {
    const target = Math.min(perWorker, remaining);
    if (target <= 0) break;
    remaining -= target;

    const threads = Math.min(threadsPerWorker, w.maxThreads);
    const taskId = `mail_${Date.now()}_${w.id}`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`http://${w.host}:${w.port}/task/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, target, threads, proxies: [], callbackUrl }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await res.json();

      if (data.error) {
        errors.push(`${w.name}: ${data.error}`);
      } else {
        assignments.push({ workerId: w.id, workerName: w.name, taskId, target, threads });
      }
    } catch (e: any) {
      errors.push(`${w.name}: ${e.message ?? '连接失败'}`);
    }
  }

  return NextResponse.json({
    ok: true,
    totalTarget,
    assigned: assignments.length,
    assignments,
    errors,
    proxyCount: proxies.length,
  });
}

// DELETE: 取消所有 worker 任务
export async function DELETE(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const workers = getWorkers(db);
  const results: any[] = [];

  for (const w of workers) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      await fetch(`http://${w.host}:${w.port}/task/cancel`, {
        method: 'POST',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      results.push({ workerId: w.id, ok: true });
    } catch {
      results.push({ workerId: w.id, ok: false });
    }
  }

  return NextResponse.json({ ok: true, results });
}
