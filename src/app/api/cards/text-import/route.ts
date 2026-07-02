import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { text = '', brand } = await req.json() as { text?: string; brand?: string };
  if (!brand) return NextResponse.json({ error: 'brand is required' }, { status: 400 });

  const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l);

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

  const insertPa = db.prepare(`
    INSERT OR IGNORE INTO payment_accounts (id, name, balance, currency, note, addedAt)
    VALUES (@id, @name, @balance, @currency, @note, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    const now = new Date().toISOString();
    for (const line of lines) {
      // Split by tab or 2+ spaces
      const fields = line.split(/\t|\s{2,}/).map((f: string) => f.trim()).filter((f: string) => f);
      if (fields.length < 3) continue;

      let idx = 0;
      // Skip first field if it's a pure number (序号)
      if (/^\d+$/.test(fields[0])) idx = 1;

      const cardNumber = fields[idx] ?? '';
      const expiry = fields[idx + 1] ?? '';
      const cvv = fields[idx + 2] ?? '';
      const cardholder = fields[idx + 3] ?? null;
      const country = fields[idx + 4] ?? null;
      const address1 = fields[idx + 5] ?? null;
      const city = fields[idx + 6] ?? null;
      const state = fields[idx + 7] ?? null;
      const zip = fields[idx + 8] ?? null;

      if (!cardNumber) continue;

      const cardId = `card_${Date.now()}_${String(count).padStart(4, '0')}`;
      const accountId = `pa_${Date.now()}_${String(count).padStart(4, '0')}`;

      // Create payment_account for this card
      insertPa.run({
        id: accountId,
        name: `${brand}-${String(count + 1).padStart(3, '0')}`,
        balance: 0,
        currency: 'USD',
        note: null,
        addedAt: now,
      });

      insertCard.run({
        id: cardId, cardNumber, expiry, cvv, brand,
        cardholder, country, address1, city, state, zip,
        accountId,
        claudeUsedCount: 0, claudeMaxUsage: 1,
        codexUsedCount: 0, codexMaxUsage: 3,
        claudePlatformUsedCount: 0, claudePlatformMaxUsage: 3,
        openaiPlatformUsedCount: 0, openaiPlatformMaxUsage: 5,
        status: 'active', deleted: 0, deletedAt: null, addedAt: now,
      });

      count++;
    }
    return count;
  });

  const imported = tx();
  return NextResponse.json({ imported });
}
