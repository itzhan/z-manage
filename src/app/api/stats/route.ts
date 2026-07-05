import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();

  const count = (table: string, where = '1=1') =>
    (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${where}`).get() as any).c;

  return NextResponse.json({
    cards: {
      total: count('cards', 'deleted = 0'),
      active: count('cards', "deleted = 0 AND status = 'active' AND allocatedTo IS NULL"),
      allocated: count('cards', 'deleted = 0 AND allocatedTo IS NOT NULL'),
    },
    google: {
      total: count('google_accounts'),
      available: count('google_accounts', 'used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL'),
      allocated: count('google_accounts', 'allocatedTo IS NOT NULL'),
    },
    mailcom: {
      total: count('mailcom_accounts'),
      available: count('mailcom_accounts', "banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"),
      allocated: count('mailcom_accounts', 'allocatedTo IS NOT NULL'),
    },
    outlook: {
      total: count('outlook_accounts'),
      available: count('outlook_accounts', "banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"),
      allocated: count('outlook_accounts', 'allocatedTo IS NOT NULL'),
    },
    proxies: {
      total: count('proxies', 'deleted = 0'),
      available: count('proxies', 'deleted = 0 AND bad = 0 AND allocatedTo IS NULL'),
      allocated: count('proxies', 'deleted = 0 AND allocatedTo IS NOT NULL'),
    },
    codex: {
      total: count('codex_credentials'),
      available: count('codex_credentials', 'allocatedTo IS NULL AND usedInvites < maxInvites'),
      allocated: count('codex_credentials', 'allocatedTo IS NOT NULL'),
    },
    registered: {
      total: count('registered_accounts'),
      authorized: count('registered_accounts', "status = 'authorized'"),
    },
    openai: {
      total: count('openai_keys'),
      active: count('openai_keys', "status = 'active'"),
      unexported: count('openai_keys', "exported = 0 OR exported IS NULL"),
    },
    workers: {
      total: count('workers'),
      online: count('workers', "status = 'online'"),
    },
    tasks: {
      total: count('dispatch_tasks'),
      running: count('dispatch_tasks', "status IN ('pending','dispatching','running')"),
      success: count('dispatch_tasks', "status = 'success'"),
      failed: count('dispatch_tasks', "status = 'failed'"),
    },
    openaiPool: {
      total: count('openai_pool'),
      available: count('openai_pool', "used = 0 AND allocatedTo IS NULL AND msRefreshToken IS NOT NULL"),
      allocated: count('openai_pool', 'allocatedTo IS NOT NULL'),
    },
    addresses: {
      total: count('addresses'),
      available: count('addresses', 'used = 0'),
    },
  });
}
