import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM cards WHERE deleted = 0').get() as any).c;
  const active = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'active'").get() as any).c;
  const exhausted = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'exhausted'").get() as any).c;
  const disabled = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'disabled'").get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND allocatedTo IS NOT NULL').get() as any).c;

  const brands = db.prepare(`
    SELECT brand, COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
    FROM cards WHERE deleted = 0 GROUP BY brand
  `).all() as any[];

  const byBrand: Record<string, any> = {};
  for (const b of brands) {
    byBrand[b.brand || '(none)'] = { total: b.total, active: b.active };
  }

  const paStats = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(balance), 0) as totalBalance FROM payment_accounts').get() as any;

  return NextResponse.json({ total, active, exhausted, disabled, allocated, byBrand, paymentAccounts: paStats });
}
