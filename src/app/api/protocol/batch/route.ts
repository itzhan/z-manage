import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';
import { spawn } from 'child_process';
import path from 'path';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const body = await req.json();
  const { count = 1, batchSize: rawBatchSize, brand, emailSource = 'mailcom', amount = 5 } = body;

  if (count < 1 || count > 500) return NextResponse.json({ error: 'count must be 1-500' }, { status: 400 });

  const db = getDb();
  const now = new Date().toISOString();
  const batchSize = rawBatchSize && rawBatchSize > 0 ? rawBatchSize : count;
  const apiKey = req.headers.get('x-api-key') || '';
  const masterUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } };

      const totalBatches = Math.ceil(count / batchSize);
      let globalSuccess = 0;
      let globalFailed = 0;
      const allTaskIds: string[] = [];

      send({ type: 'start', total: count, batchSize, batches: totalBatches });

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchStart = batchIdx * batchSize;
        const batchCount = Math.min(batchSize, count - batchStart);

        send({ type: 'batch_start', batch: batchIdx + 1, batches: totalBatches, batchCount });

        // Pull resources for this batch
        const tasks: Array<{ taskId: string; email: any; card: any; proxy: any; address: any }> = [];

        for (let i = 0; i < batchCount; i++) {
          const taskId = `p_${Date.now()}_${batchStart + i}_${Math.random().toString(36).slice(2, 6)}`;

          // Pull email
          const emailEndpoint = emailSource === 'outlook' ? 'outlook_accounts' : 'mailcom_accounts';
          const emailRow = db.prepare(`SELECT * FROM ${emailEndpoint} WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok' ORDER BY addedAt DESC LIMIT 1`).get() as any;
          if (!emailRow) { send({ type: 'error', message: `邮箱不足 (已分配${i}个)` }); break; }
          db.prepare(`UPDATE ${emailEndpoint} SET allocatedTo = 'protocol', allocatedAt = ? WHERE id = ?`).run(now, emailRow.id);

          // Pull card
          const platformCol = 'claudePlatformUsedCount';
          const platformMax = 'claudePlatformMaxUsage';
          let cardQuery = `SELECT * FROM cards WHERE deleted = 0 AND status = 'active' AND allocatedTo IS NULL AND ${platformCol} < ${platformMax}`;
          const cardParams: any[] = [];
          if (brand) { cardQuery += ' AND brand = ?'; cardParams.push(brand); }
          cardQuery += ' ORDER BY addedAt ASC LIMIT 1';
          const cardRow = db.prepare(cardQuery).get(...cardParams) as any;
          if (!cardRow) {
            db.prepare(`UPDATE ${emailEndpoint} SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ?`).run(emailRow.id);
            send({ type: 'error', message: `卡不足 (已分配${i}个)` });
            break;
          }
          db.prepare(`UPDATE cards SET allocatedTo = 'protocol', allocatedAt = ?, ${platformCol} = ${platformCol} + 1 WHERE id = ?`).run(now, cardRow.id);

          // Pull proxy
          const proxyRow = db.prepare("SELECT * FROM proxies WHERE bad = 0 AND deleted = 0 AND allocatedTo IS NULL ORDER BY RANDOM() LIMIT 1").get() as any;
          if (!proxyRow) {
            db.prepare(`UPDATE ${emailEndpoint} SET allocatedTo = NULL WHERE id = ?`).run(emailRow.id);
            db.prepare(`UPDATE cards SET allocatedTo = NULL, ${platformCol} = MAX(0, ${platformCol} - 1) WHERE id = ?`).run(cardRow.id);
            send({ type: 'error', message: `代理不足 (已分配${i}个)` });
            break;
          }
          db.prepare("UPDATE proxies SET allocatedTo = 'protocol', allocatedAt = ? WHERE id = ?").run(now, proxyRow.id);

          // Pull address
          const addrRow = db.prepare("SELECT * FROM addresses WHERE used = 0 LIMIT 1").get() as any;

          // Record task
          db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, resources, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
            taskId, 'claude-protocol', 'pending', JSON.stringify({ brand, emailSource, amount }),
            JSON.stringify({ mailcomEmail: emailRow.email, cardId: cardRow.id, proxyId: proxyRow.id, emailSource }),
            now
          );
          allTaskIds.push(taskId);

          tasks.push({ taskId, email: emailRow, card: cardRow, proxy: proxyRow, address: addrRow });
        }

        send({ type: 'batch_resources', batch: batchIdx + 1, count: tasks.length });

        // Execute tasks with concurrency
        const CONCURRENCY = 3;
        let idx = 0;

        const runOne = async () => {
          while (idx < tasks.length) {
            const i = idx++;
            const t = tasks[i];
            const proxyUrl = `http://${t.proxy.user}:${t.proxy.pass}@${t.proxy.host}:${t.proxy.port}`;
            const emailTable = emailSource === 'outlook' ? 'outlook_accounts' : 'mailcom_accounts';

            const args = [
              path.resolve('scripts/claude_protocol.py'),
              '--email', t.email.email,
              '--password', t.email.password || '',
              '--email-source', emailSource,
              '--card-number', t.card.cardNumber,
              '--card-expiry', (t.card.expiry || '').replace('/', ''),
              '--card-cvv', t.card.cvv || '',
              '--proxy', proxyUrl,
              '--amount', String(amount),
              '--master-url', masterUrl,
              '--master-api-key', apiKey,
            ];
            if (emailSource === 'outlook') {
              args.push('--outlook-client-id', t.email.clientId || '');
              args.push('--outlook-refresh-token', t.email.refreshToken || '');
            }
            if (t.address) {
              args.push('--address', JSON.stringify({ address1: t.address.address1, city: t.address.city, state: t.address.state, zip: t.address.zip }));
            }

            db.prepare('UPDATE dispatch_tasks SET status = ?, dispatchedAt = ? WHERE id = ?').run('running', new Date().toISOString(), t.taskId);
            send({ type: 'task_start', batch: batchIdx + 1, taskIdx: i + 1, total: tasks.length, email: t.email.email });

            try {
              const result = await new Promise<{ success: boolean; key?: string; error?: string }>((resolve) => {
                let output = '';
                const proc = spawn('python3', args, { cwd: path.resolve('.') });
                proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
                proc.stderr.on('data', (d: Buffer) => { /* log but ignore */ });
                proc.on('close', (code) => {
                  const lastLine = output.trim().split('\n').pop() || '';
                  try {
                    const parsed = JSON.parse(lastLine);
                    resolve(parsed);
                  } catch {
                    resolve({ success: false, error: code ? `exit ${code}` : 'no output' });
                  }
                });
                // Timeout 10 min
                setTimeout(() => { try { proc.kill(); } catch {} resolve({ success: false, error: 'timeout 10min' }); }, 600000);
              });

              if (result.success && result.key) {
                db.prepare('UPDATE dispatch_tasks SET status = ?, result = ?, finishedAt = ? WHERE id = ?').run('success', JSON.stringify(result), new Date().toISOString(), t.taskId);
                // Report key
                db.prepare('INSERT OR IGNORE INTO registered_accounts (email, session_key, status, platform, registered_at) VALUES (?, ?, ?, ?, ?)').run(t.email.email, result.key, 'active', 'claude-protocol', new Date().toISOString());
                // Release resources
                db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(t.email.id);
                db.prepare("UPDATE cards SET allocatedTo = NULL WHERE id = ?").run(t.card.id);
                db.prepare("UPDATE proxies SET allocatedTo = NULL WHERE id = ?").run(t.proxy.id);
                globalSuccess++;
                send({ type: 'task_done', batch: batchIdx + 1, taskIdx: i + 1, success: true, key: result.key?.slice(0, 30) + '...', email: t.email.email, globalSuccess, globalFailed, total: count });
              } else {
                const errMsg = result.error || 'unknown';
                db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', errMsg, new Date().toISOString(), t.taskId);
                // Release resources
                db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(t.email.id);
                db.prepare(`UPDATE cards SET allocatedTo = NULL, claudePlatformUsedCount = MAX(0, claudePlatformUsedCount - 1) WHERE id = ?`).run(t.card.id);
                db.prepare("UPDATE proxies SET allocatedTo = NULL WHERE id = ?").run(t.proxy.id);
                globalFailed++;
                send({ type: 'task_done', batch: batchIdx + 1, taskIdx: i + 1, success: false, error: errMsg, email: t.email.email, globalSuccess, globalFailed, total: count });
              }
            } catch (e: any) {
              db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', e.message, new Date().toISOString(), t.taskId);
              db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(t.email.id);
              db.prepare(`UPDATE cards SET allocatedTo = NULL, claudePlatformUsedCount = MAX(0, claudePlatformUsedCount - 1) WHERE id = ?`).run(t.card.id);
              db.prepare("UPDATE proxies SET allocatedTo = NULL WHERE id = ?").run(t.proxy.id);
              globalFailed++;
              send({ type: 'task_done', batch: batchIdx + 1, taskIdx: i + 1, success: false, error: e.message, email: t.email.email, globalSuccess, globalFailed, total: count });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => runOne()));

        send({ type: 'batch_done', batch: batchIdx + 1, batches: totalBatches, globalSuccess, globalFailed });
      }

      logAllocation(db, 'protocol', 'batch', a.keyName || '未知', count, { globalSuccess, globalFailed, emailSource, brand });
      send({ type: 'done', total: count, success: globalSuccess, failed: globalFailed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
