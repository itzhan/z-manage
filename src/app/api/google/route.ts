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
  const conditions: string[] = [];
  const params: any[] = [];
  const status = req.nextUrl.searchParams.get('status');
  const allocatedTo = req.nextUrl.searchParams.get('allocatedTo');
  if (status === 'available') { conditions.push('used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL'); }
  else if (status === 'used') { conditions.push('used = 1'); }
  else if (status === 'abnormal') { conditions.push('(captcha = 1 OR abnormal = 1)'); }
  if (allocatedTo) { conditions.push('allocatedTo = ?'); params.push(allocatedTo); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM google_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM google_accounts WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;
  const db = getDb();
  const { accounts = [] } = await req.json();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO google_accounts (id, email, password, recoveryEmail, twoFaSecret, used, captcha, abnormal, abnormal_reason, addedAt)
    VALUES (@id, @email, @password, @recoveryEmail, @twoFaSecret, @used, @captcha, @abnormal, @abnormal_reason, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `ga_${Date.now()}_${count}`,
        email: a.email, password: a.password,
        recoveryEmail: a.recoveryEmail ?? null,
        twoFaSecret: a.twoFaSecret ?? null,
        used: a.used ? 1 : 0,
        captcha: a.captcha ? 1 : 0,
        abnormal: a.abnormal ? 1 : 0,
        abnormal_reason: a.abnormal_reason ?? null,
        addedAt: a.addedAt ?? new Date().toISOString(),
      });
      count++;
    }
    return count;
  });

  return NextResponse.json({ imported: tx() });
}
