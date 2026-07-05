import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';
import { refreshOutlookToken } from '@/lib/outlook';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();

  const rows = db.prepare("SELECT * FROM outlook_accounts WHERE tokenStatus = 'failed' OR (tokenStatus = 'ok' AND accessToken IS NULL)").all() as any[];

  if (rows.length === 0) {
    return new Response(JSON.stringify({ total: 0, success: 0, failed: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const total = rows.length;
      let done = 0, success = 0, failed = 0;
      const CONCURRENCY = 10;

      send({ type: 'start', total });

      let idx = 0;
      const runOne = async () => {
        while (idx < rows.length) {
          const row = rows[idx++];
          try {
            const tokens = await refreshOutlookToken(row.clientId, row.refreshToken);
            db.prepare("UPDATE outlook_accounts SET accessToken = ?, refreshToken = ?, tokenStatus = 'ok', tokenAt = ?, tokenError = NULL WHERE email = ?")
              .run(tokens.accessToken, tokens.refreshToken, new Date().toISOString(), row.email);
            success++;
          } catch (err: any) {
            db.prepare("UPDATE outlook_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?").run(err.message, row.email);
            failed++;
          }
          done++;
          if (done % 10 === 0 || done === total) {
            send({ type: 'progress', email: rows[done - 1]?.email, done, total, success, failed });
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => runOne()));
      send({ type: 'done', total, success, failed });
      controller.close();
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}
