import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  const sourceKeyName = req.nextUrl.searchParams.get('sourceKeyName');
  if (sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(sourceKeyName); }
  const exported = req.nextUrl.searchParams.get('exported');
  if (exported === '1') { conditions.push('exported = 1'); }
  else { conditions.push('(exported = 0 OR exported IS NULL)'); }
  conditions.push("apiKey IS NOT NULL AND apiKey != ''");
  const where = conditions.join(' AND ');

  const exportLimit = parseInt(req.nextUrl.searchParams.get('limit') || '') || 0;
  const query = `SELECT id, apiKey FROM openai_keys WHERE ${where} ORDER BY uploadedAt DESC` + (exportLimit > 0 ? ` LIMIT ${exportLimit}` : '');
  const rows = db.prepare(query).all(...params) as any[];
  const text = rows.map((r: any) => r.apiKey).join('\n');

  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE openai_keys SET exported = 1, exportedAt = ? WHERE id IN (${placeholders})`).run(new Date().toISOString(), ...ids);
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(text, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="openai_keys_${date}.txt"`,
      'Content-Length': String(Buffer.byteLength(text)),
    },
  });
}
