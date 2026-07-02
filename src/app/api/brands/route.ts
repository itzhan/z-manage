import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT brand FROM cards WHERE brand IS NOT NULL AND brand != '' ORDER BY brand").all() as any[];
  return NextResponse.json({ brands: rows.map(r => r.brand) });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  // Brands are auto-created when cards are imported
  return NextResponse.json({ success: true });
}
