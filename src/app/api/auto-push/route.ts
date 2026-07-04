import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getStatus, setEnabled, initAutoPush } from '@/lib/auto-push';

// Initialize on first request (server-side singleton)
initAutoPush();

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  return NextResponse.json(getStatus());
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const { enabled, hubUrl } = await req.json();
  setEnabled(!!enabled, hubUrl);
  return NextResponse.json(getStatus());
}
