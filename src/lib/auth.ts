import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const API_KEYS_PATH = path.resolve('data/api_keys.json');

interface ApiKeyEntry {
  key: string;
  name: string;
}

export function loadApiKeys(): ApiKeyEntry[] {
  try {
    if (fs.existsSync(API_KEYS_PATH)) {
      const raw = fs.readFileSync(API_KEYS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed.keys && Array.isArray(parsed.keys)) return parsed.keys;
    }
  } catch { /* fallback below */ }

  const envKey = process.env.API_KEY;
  if (envKey) {
    return [{ key: envKey, name: 'default' }];
  }
  return [];
}

export function saveApiKeys(keys: ApiKeyEntry[]): void {
  const dir = path.dirname(API_KEYS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(API_KEYS_PATH, JSON.stringify({ keys }, null, 2), 'utf-8');
}

export function auth(req: NextRequest): { ok: boolean; keyName?: string; error?: NextResponse } {
  const headerKey = req.headers.get('x-api-key');
  const urlKey = req.nextUrl.searchParams.get('_key');
  const providedKey = headerKey || urlKey;

  if (!providedKey) {
    return {
      ok: false,
      error: NextResponse.json({ error: 'Missing API key' }, { status: 401 }),
    };
  }

  const keys = loadApiKeys();

  if (keys.length === 0) {
    return {
      ok: false,
      error: NextResponse.json({ error: 'No API keys configured' }, { status: 500 }),
    };
  }

  const match = keys.find((k) => k.key === providedKey);
  if (!match) {
    return {
      ok: false,
      error: NextResponse.json({ error: 'Invalid API key' }, { status: 403 }),
    };
  }

  return { ok: true, keyName: match.name };
}
