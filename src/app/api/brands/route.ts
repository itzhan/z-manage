import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const sp = req.nextUrl.searchParams;
  const platform = sp.get('platform') || '';
  const minBalance = parseFloat(sp.get('minBalance') || '0') || 0;

  const db = getDb();

  const platformCol: Record<string, [string, string]> = {
    claudePlatform: ['claudePlatformUsedCount', 'claudePlatformMaxUsage'],
    openaiPlatform: ['openaiPlatformUsedCount', 'openaiPlatformMaxUsage'],
    claude: ['claudeUsedCount', 'claudeMaxUsage'],
    codex: ['codexUsedCount', 'codexMaxUsage'],
  };

  let availableSql = "status = 'active' AND allocatedTo IS NULL";
  if (platform && platformCol[platform]) {
    const [used, max] = platformCol[platform];
    availableSql += ` AND ${used} < ${max}`;
  }

  let balanceJoin = '';
  let balanceCond = '';
  if (minBalance > 0) {
    balanceJoin = 'LEFT JOIN payment_accounts pa ON c.accountId = pa.id';
    balanceCond = ` AND (pa.balance IS NULL OR pa.balance >= ${minBalance})`;
  }

  let remainingSql = '0';
  if (platform && platformCol[platform]) {
    const [used, max] = platformCol[platform];
    remainingSql = `SUM(CASE WHEN ${availableSql}${balanceCond} THEN (${max} - ${used}) ELSE 0 END)`;
  }

  const rows = db.prepare(`
    SELECT c.brand,
      COUNT(*) as total,
      SUM(CASE WHEN ${availableSql}${balanceCond} THEN 1 ELSE 0 END) as available,
      ${remainingSql} as remainingUses
    FROM cards c
    ${balanceJoin}
    WHERE c.deleted = 0 AND c.brand IS NOT NULL AND c.brand != ''
    GROUP BY c.brand ORDER BY c.brand
  `).all() as any[];

  return NextResponse.json({
    brands: rows.map(r => r.brand),
    details: rows.map(r => ({ brand: r.brand, total: r.total, available: r.available, remainingUses: r.remainingUses ?? 0 })),
  });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  // Brands are auto-created when cards are imported
  return NextResponse.json({ success: true });
}
