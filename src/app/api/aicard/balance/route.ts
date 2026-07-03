import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

const AICARD_KEY = process.env.AICARD_API_KEY || '';
const AICARD_CUSTOMER = process.env.AICARD_CUSTOMER_ID || '';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  if (!AICARD_KEY) return NextResponse.json({ error: 'AICARD_API_KEY not configured' });

  try {
    const [balRes, cusRes] = await Promise.all([
      fetch('https://aicardapi.com/v1/ledger/balances', { headers: { 'X-API-Key': AICARD_KEY } }).then(r => r.json()),
      AICARD_CUSTOMER ? fetch(`https://aicardapi.com/v1/customers/${AICARD_CUSTOMER}`, { headers: { 'X-API-Key': AICARD_KEY } }).then(r => r.json()) : null,
    ]);
    return NextResponse.json({
      merchantBalance: balRes?.data?.available_balance_usd ?? balRes?.data?.cash_usd ?? 0,
      customerAllocated: cusRes?.data?.funding?.allocated_balance_usd ?? 0,
      customerId: AICARD_CUSTOMER,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
