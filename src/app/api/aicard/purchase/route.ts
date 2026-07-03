import { NextRequest } from 'next/server';
import { getDb, logAllocation } from '@/lib/db';
import { auth } from '@/lib/auth';

const AICARD_BASE = 'https://aicardapi.com';
const AICARD_KEY = process.env.AICARD_API_KEY || '';
const AICARD_CUSTOMER = process.env.AICARD_CUSTOMER_ID || '';
const ISSUANCE_FEE = 1;

async function aicardFetch(method: string, path: string, body?: any, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { 'X-API-Key': AICARD_KEY, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${AICARD_BASE}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res.json();
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  if (!AICARD_KEY || !AICARD_CUSTOMER) {
    return new Response(JSON.stringify({ error: 'AICARD not configured' }), { status: 400 });
  }

  const { count = 10, amountPerCard = 10, concurrency = 5, brand = 'AICard-API' } = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        const totalCost = count * (amountPerCard + ISSUANCE_FEE);
        const cusData = await aicardFetch('GET', `/v1/customers/${AICARD_CUSTOMER}`);
        const currentBalance = cusData?.data?.funding?.allocated_balance_usd ?? 0;
        const needFund = Math.max(0, totalCost - currentBalance);

        send({ type: 'info', totalCost, currentBalance, needFund, count, amountPerCard });

        if (needFund > 0) {
          send({ type: 'funding', amount: needFund });
          const fundResult = await aicardFetch('POST', `/v1/customers/${AICARD_CUSTOMER}/funding`, {
            amount_usd: needFund, reason: `Purchase ${count} cards at $${amountPerCard} each`,
          }, `fund_purchase_${Date.now()}`);
          if (fundResult.error) { send({ type: 'error', message: `充值失败: ${fundResult.error.message}` }); controller.close(); return; }
          send({ type: 'funded', newBalance: fundResult?.data?.customer?.funding?.allocated_balance_usd });
        }

        send({ type: 'creating', count, concurrency });
        const cardIds: string[] = [];
        let created = 0, failed = 0, idx = 0;

        const createOne = async (): Promise<void> => {
          while (idx < count) {
            const i = idx++;
            const result = await aicardFetch('POST', '/v1/cards', {
              customer_id: AICARD_CUSTOMER, type: 'virtual', card_usage_type: 'temporary', spend_limit_usd: amountPerCard,
            }, `purchase_card_${Date.now()}_${i}`);
            if (result?.data?.id) {
              created++;
              cardIds.push(result.data.id);
              send({ type: 'card_created', idx: created, total: count, id: result.data.id, last4: result.data.last4, created, failed });
            } else {
              failed++;
              send({ type: 'card_failed', idx: created + failed, total: count, error: result?.error?.message, created, failed });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => createOne()));

        if (cardIds.length === 0) { send({ type: 'error', message: '没有成功创建任何卡' }); controller.close(); return; }

        send({ type: 'revealing', count: cardIds.length });
        const db = getDb();
        const now = new Date().toISOString();
        const CARD_COLS = ["id","cardNumber","expiry","cvv","brand","claudeUsedCount","codexUsedCount","claudeMaxUsage","codexMaxUsage","claudePlatformUsedCount","claudePlatformMaxUsage","openaiPlatformUsedCount","openaiPlatformMaxUsage","accountId","status","addedAt","cardholder","country","address1","city","state","zip","deleted","deletedAt"];
        const upsertCard = db.prepare(`INSERT OR REPLACE INTO cards (${CARD_COLS.join(',')}) VALUES (${CARD_COLS.map(() => '?').join(',')})`);
        const upsertPa = db.prepare('INSERT OR REPLACE INTO payment_accounts (id,name,balance,currency,note,addedAt) VALUES (?,?,?,?,?,?)');

        // Reveal cards in parallel
        const cards: any[] = [];
        let revealDone = 0;
        let revealIdx = 0;

        const revealOne = async (): Promise<void> => {
          while (revealIdx < cardIds.length) {
            const i = revealIdx++;
            const cid = cardIds[i];
            const reveal = await aicardFetch('POST', `/v1/cards/${cid}/secure-reveal`, { reason: 'Batch purchase export' }, `reveal_${cid}_${Date.now()}`);
            const d = reveal?.data;
            if (d?.card_number) {
              const exp = d.expiration_date || '';
              const expiry = exp.slice(0, 2) + '/' + exp.slice(2);
              cards.push({ id: cid, cardNumber: d.card_number, cvv: d.security_code, expiry });
            }
            revealDone++;
            send({ type: 'revealed', idx: revealDone, total: cardIds.length, cardNumber: d?.card_number, cvv: d?.security_code });
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, cardIds.length) }, () => revealOne()));

        // Import to DB
        const dbTx = db.transaction(() => {
          for (let i = 0; i < cards.length; i++) {
            const c = cards[i];
            const paId = `pa_aicard_${Date.now()}_${i}`;
            upsertPa.run(paId, `${brand}-${i + 1}`, amountPerCard, 'USD', null, now);
            const vals = CARD_COLS.map(col => {
              if (col === 'accountId') return paId;
              if (col === 'brand') return brand;
              if (col === 'status') return 'active';
              if (col === 'addedAt') return now;
              if (col === 'claudeUsedCount' || col === 'codexUsedCount' || col === 'claudePlatformUsedCount' || col === 'openaiPlatformUsedCount') return 0;
              if (col === 'claudeMaxUsage') return 1;
              if (col === 'codexMaxUsage') return 3;
              if (col === 'claudePlatformMaxUsage') return 3;
              if (col === 'openaiPlatformMaxUsage') return 5;
              if (col === 'deleted') return 0;
              return (c as any)[col] ?? null;
            });
            upsertCard.run(...vals);
          }
        });
        dbTx();

        logAllocation(db, 'cards', 'aicard-purchase', a.keyName || '未知', cards.length, { brand, amountPerCard, count: cards.length });
        send({ type: 'done', created: cards.length, failed, brand, amountPerCard });
      } catch (e: any) {
        send({ type: 'error', message: e.message });
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}
