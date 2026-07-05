import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { emails } = await req.json() as { emails?: string[] };

  let rows: any[];
  if (emails && emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${placeholders})`).all(...emails) as any[];
  } else {
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE tokenStatus = 'failed' OR (tokenStatus = 'ok' AND accessToken IS NULL)`).all() as any[];
  }

  if (rows.length === 0) {
    return new Response(JSON.stringify({ total: 0, success: 0, failed: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 加载代理池
  const proxies = db.prepare("SELECT host, port, user, pass FROM proxies WHERE bad = 0 AND deleted = 0").all() as any[];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // @ts-ignore
      const { MailComClient, MemorySessionStore } = await import('@/mailcom-sdk/index.js');

      const total = rows.length;
      let done = 0, success = 0, failed = 0;

      // 每个代理最多承担 20 个，随机打散
      const PER_PROXY = 20;
      const proxyUsage = new Map<number, number>();

      const getProxyFetch = () => {
        if (proxies.length === 0) return undefined;
        // 找使用次数最少的代理
        let bestIdx = Math.floor(Math.random() * proxies.length);
        let bestCount = proxyUsage.get(bestIdx) ?? 0;
        for (let i = 0; i < 5; i++) {
          const ri = Math.floor(Math.random() * proxies.length);
          const rc = proxyUsage.get(ri) ?? 0;
          if (rc < bestCount) { bestIdx = ri; bestCount = rc; }
        }
        if (bestCount >= PER_PROXY) {
          // 所有随机采样的都满了，找一个真正最小的
          let minIdx = 0, minCount = proxyUsage.get(0) ?? 0;
          for (let i = 1; i < proxies.length; i++) {
            const c = proxyUsage.get(i) ?? 0;
            if (c < minCount) { minIdx = i; minCount = c; }
          }
          bestIdx = minIdx;
        }
        proxyUsage.set(bestIdx, (proxyUsage.get(bestIdx) ?? 0) + 1);
        const p = proxies[bestIdx];
        const proxyUrl = `http://${p.user}:${p.pass}@${p.host}:${p.port}`;
        const agent = new ProxyAgent(proxyUrl);
        return (url: any, init: any) => undiciFetch(url, { ...init, dispatcher: agent });
      };

      send({ type: 'start', total, proxies: proxies.length });

      const CONCURRENCY = 15;
      let idx = 0;

      const runOne = async (): Promise<void> => {
        while (idx < rows.length) {
          const row = rows[idx++];
          try {
            const store = new MemorySessionStore();
            const proxyFetch = getProxyFetch();
            const client = new MailComClient({
              email: row.email, password: row.password, sessionStore: store,
              ...(proxyFetch ? { fetch: proxyFetch } : {}),
            });
            const session = await client.auth.login();
            const now = new Date().toISOString();
            db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ?, tokenError = NULL WHERE email = ?`)
            // @ts-ignore
              .run(session!.accessToken, session!.refreshToken, session!.expiresAt ? new Date(session!.expiresAt).toISOString() : null, now, row.email);
            success++;
            send({ type: 'progress', email: row.email, status: 'ok', done: ++done, total, success, failed });
          } catch (err: any) {
            const msg = err.message || String(err);
            db.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`).run(msg, row.email);
            failed++;
            send({ type: 'progress', email: row.email, status: 'failed', error: msg, done: ++done, total, success, failed });
          }
        }
      };

      const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => runOne());
      await Promise.all(workers);

      send({ type: 'done', total, success, failed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
