import { NextRequest, NextResponse } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

const PROTOCOL_SERVER = process.env.PROTOCOL_SERVER_URL || 'http://host.docker.internal:9876';

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

      send({ type: 'start', total: count, batchSize, batches: totalBatches });

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchStart = batchIdx * batchSize;
        const batchCount = Math.min(batchSize, count - batchStart);

        send({ type: 'batch_start', batch: batchIdx + 1, batches: totalBatches, batchCount });

        // Pull resources for this batch
        const tasks: Array<{ taskId: string; email: any; card: any; proxy: any; address: any }> = [];
        const emailTable = emailSource === 'outlook' ? 'outlook_accounts' : 'mailcom_accounts';

        for (let i = 0; i < batchCount; i++) {
          const taskId = `p_${Date.now()}_${batchStart + i}_${Math.random().toString(36).slice(2, 6)}`;

          const emailRow = db.prepare(`SELECT * FROM ${emailTable} WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok' ORDER BY addedAt DESC LIMIT 1`).get() as any;
          if (!emailRow) { send({ type: 'error', message: `邮箱不足 (已分配${i}个)` }); break; }
          db.prepare(`UPDATE ${emailTable} SET allocatedTo = 'protocol', allocatedAt = ? WHERE id = ?`).run(now, emailRow.id);

          let cardQuery = `SELECT * FROM cards WHERE deleted = 0 AND status = 'active' AND allocatedTo IS NULL AND claudePlatformUsedCount < claudePlatformMaxUsage`;
          const cardParams: any[] = [];
          if (brand) { cardQuery += ' AND brand = ?'; cardParams.push(brand); }
          cardQuery += ' ORDER BY addedAt ASC LIMIT 1';
          const cardRow = db.prepare(cardQuery).get(...cardParams) as any;
          if (!cardRow) {
            db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(emailRow.id);
            send({ type: 'error', message: `卡不足 (已分配${i}个)` }); break;
          }
          db.prepare(`UPDATE cards SET allocatedTo = 'protocol', allocatedAt = ?, claudePlatformUsedCount = claudePlatformUsedCount + 1 WHERE id = ?`).run(now, cardRow.id);

          const proxyRow = db.prepare("SELECT * FROM proxies WHERE bad = 0 AND deleted = 0 AND allocatedTo IS NULL ORDER BY RANDOM() LIMIT 1").get() as any;
          if (!proxyRow) {
            db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(emailRow.id);
            db.prepare(`UPDATE cards SET allocatedTo = NULL, claudePlatformUsedCount = MAX(0, claudePlatformUsedCount - 1) WHERE id = ?`).run(cardRow.id);
            send({ type: 'error', message: `代理不足 (已分配${i}个)` }); break;
          }
          db.prepare("UPDATE proxies SET allocatedTo = 'protocol', allocatedAt = ? WHERE id = ?").run(now, proxyRow.id);

          const addrRow = db.prepare("SELECT * FROM addresses WHERE used = 0 LIMIT 1").get() as any;

          db.prepare('INSERT INTO dispatch_tasks (id, action, status, params, resources, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
            taskId, 'claude-protocol', 'pending', JSON.stringify({ brand, emailSource, amount }),
            JSON.stringify({ mailcomEmail: emailRow.email, cardId: cardRow.id, proxyId: proxyRow.id, emailSource }),
            now
          );

          tasks.push({ taskId, email: emailRow, card: cardRow, proxy: proxyRow, address: addrRow });
        }

        send({ type: 'batch_resources', batch: batchIdx + 1, count: tasks.length });

        // Execute tasks with concurrency via protocol server
        const CONCURRENCY = 3;
        let idx = 0;

        const runOne = async () => {
          while (idx < tasks.length) {
            const i = idx++;
            const t = tasks[i];
            const proxyUrl = `http://${t.proxy.user}:${t.proxy.pass}@${t.proxy.host}:${t.proxy.port}`;

            db.prepare('UPDATE dispatch_tasks SET status = ?, dispatchedAt = ? WHERE id = ?').run('running', new Date().toISOString(), t.taskId);
            send({ type: 'task_start', batch: batchIdx + 1, taskIdx: i + 1, total: tasks.length, email: t.email.email });

            const reqBody: Record<string, string> = {
              email: t.email.email,
              password: t.email.password || '',
              email_source: emailSource,
              card_number: t.card.cardNumber,
              card_expiry: (t.card.expiry || '').replace('/', ''),
              card_cvv: t.card.cvv || '',
              proxy: proxyUrl,
              amount: String(amount),
              master_url: masterUrl,
              master_api_key: apiKey,
            };
            if (emailSource === 'outlook') {
              reqBody.outlook_client_id = t.email.clientId || '';
              reqBody.outlook_refresh_token = t.email.refreshToken || '';
            }
            if (t.address) {
              reqBody.address = JSON.stringify({ address1: t.address.address1, city: t.address.city, state: t.address.state, zip: t.address.zip });
            }

            try {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 660000);
              const resp = await fetch(`${PROTOCOL_SERVER}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody),
                signal: ctrl.signal,
              });
              clearTimeout(timer);
              const result = await resp.json() as { success: boolean; key?: string; error?: string };

              if (result.success && result.key) {
                db.prepare('UPDATE dispatch_tasks SET status = ?, result = ?, finishedAt = ? WHERE id = ?').run('success', JSON.stringify(result), new Date().toISOString(), t.taskId);
                db.prepare('INSERT OR IGNORE INTO registered_accounts (email, session_key, status, platform, registered_at) VALUES (?, ?, ?, ?, ?)').run(t.email.email, result.key, 'active', 'claude-protocol', new Date().toISOString());
                db.prepare(`UPDATE ${emailTable} SET allocatedTo = NULL WHERE id = ?`).run(t.email.id);
                db.prepare("UPDATE cards SET allocatedTo = NULL WHERE id = ?").run(t.card.id);
                db.prepare("UPDATE proxies SET allocatedTo = NULL WHERE id = ?").run(t.proxy.id);
                globalSuccess++;
                send({ type: 'task_done', batch: batchIdx + 1, taskIdx: i + 1, success: true, key: (result.key || '').slice(0, 30) + '...', email: t.email.email, globalSuccess, globalFailed, total: count });
              } else {
                const errMsg = result.error || 'unknown';
                db.prepare('UPDATE dispatch_tasks SET status = ?, errorReason = ?, finishedAt = ? WHERE id = ?').run('failed', errMsg, new Date().toISOString(), t.taskId);
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
