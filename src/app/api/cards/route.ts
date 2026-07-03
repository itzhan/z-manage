import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const page = parseInt(req.nextUrl.searchParams.get('page') || '') || 1;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '') || 50, 200);
  const offset = (page - 1) * limit;
  const conditions = ['c.deleted = 0'];
  const params: any[] = [];
  const status = req.nextUrl.searchParams.get('status');
  const brand = req.nextUrl.searchParams.get('brand');
  const allocatedTo = req.nextUrl.searchParams.get('allocatedTo');
  const search = req.nextUrl.searchParams.get('search');
  if (status) { conditions.push('c.status = ?'); params.push(status); }
  if (brand) { conditions.push('c.brand = ?'); params.push(brand); }
  if (allocatedTo) { conditions.push('c.allocatedTo = ?'); params.push(allocatedTo); }
  if (search) { conditions.push("(c.cardNumber LIKE ? OR c.brand LIKE ? OR c.cardholder LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const where = conditions.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) as c FROM cards c WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT c.*, pa.name as accountName, pa.balance as accountBalance FROM cards c LEFT JOIN payment_accounts pa ON c.accountId = pa.id WHERE ${where} ORDER BY c.addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { cards = [], paymentAccounts = [] } = await req.json();

  const insertPa = db.prepare(`
    INSERT OR REPLACE INTO payment_accounts (id, name, balance, currency, note, addedAt)
    VALUES (@id, @name, @balance, @currency, @note, @addedAt)
  `);
  const insertCard = db.prepare(`
    INSERT OR REPLACE INTO cards (
      id, cardNumber, expiry, cvv, brand, cardholder, country, address1, city, state, zip,
      accountId, claudeUsedCount, claudeMaxUsage, codexUsedCount, codexMaxUsage,
      claudePlatformUsedCount, claudePlatformMaxUsage, openaiPlatformUsedCount, openaiPlatformMaxUsage,
      status, deleted, deletedAt, addedAt
    ) VALUES (
      @id, @cardNumber, @expiry, @cvv, @brand, @cardholder, @country, @address1, @city, @state, @zip,
      @accountId, @claudeUsedCount, @claudeMaxUsage, @codexUsedCount, @codexMaxUsage,
      @claudePlatformUsedCount, @claudePlatformMaxUsage, @openaiPlatformUsedCount, @openaiPlatformMaxUsage,
      @status, @deleted, @deletedAt, @addedAt
    )
  `);

  const tx = db.transaction(() => {
    let paCount = 0, cardCount = 0;
    for (const pa of paymentAccounts) {
      insertPa.run({
        id: pa.id, name: pa.name, balance: pa.balance ?? 0,
        currency: pa.currency ?? 'USD', note: pa.note ?? null,
        addedAt: pa.addedAt ?? new Date().toISOString(),
      });
      paCount++;
    }
    for (const c of cards) {
      insertCard.run({
        id: c.id, cardNumber: c.cardNumber, expiry: c.expiry ?? null, cvv: c.cvv ?? null,
        brand: c.brand ?? null, cardholder: c.cardholder ?? null,
        country: c.country ?? null, address1: c.address1 ?? null,
        city: c.city ?? null, state: c.state ?? null, zip: c.zip ?? null,
        accountId: c.accountId ?? null,
        claudeUsedCount: c.claudeUsedCount ?? 0, claudeMaxUsage: c.claudeMaxUsage ?? 1,
        codexUsedCount: c.codexUsedCount ?? 0, codexMaxUsage: c.codexMaxUsage ?? 3,
        claudePlatformUsedCount: c.claudePlatformUsedCount ?? 0, claudePlatformMaxUsage: c.claudePlatformMaxUsage ?? 3,
        openaiPlatformUsedCount: c.openaiPlatformUsedCount ?? 0, openaiPlatformMaxUsage: c.openaiPlatformMaxUsage ?? 5,
        status: c.status ?? 'active', deleted: c.deleted ? 1 : 0,
        deletedAt: c.deletedAt ?? null, addedAt: c.addedAt ?? new Date().toISOString(),
      });
      cardCount++;
    }
    return { paymentAccounts: paCount, cards: cardCount };
  });

  const result = tx();
  return NextResponse.json({ imported: result });
}
