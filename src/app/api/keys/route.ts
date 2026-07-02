import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { auth, loadApiKeys, saveApiKeys } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const keys = loadApiKeys();
  return NextResponse.json({
    keys: keys.map(k => ({
      name: k.name,
      key: k.key.length > 4 ? k.key.slice(0, 4) + '****' : '****',
    })),
  });
}

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { name, key } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const keys = loadApiKeys();
  if (keys.some(k => k.name === name)) {
    return NextResponse.json({ error: `key with name "${name}" already exists` }, { status: 400 });
  }

  const newKey = key || crypto.randomBytes(16).toString('hex');
  keys.push({ name, key: newKey });
  saveApiKeys(keys);

  return NextResponse.json({ name, key: newKey });
}

export async function DELETE(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { name } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const keys = loadApiKeys();
  if (keys.length <= 1) {
    return NextResponse.json({ error: 'cannot delete the last key' }, { status: 400 });
  }

  const idx = keys.findIndex(k => k.name === name);
  if (idx === -1) {
    return NextResponse.json({ error: `key "${name}" not found` }, { status: 404 });
  }

  keys.splice(idx, 1);
  saveApiKeys(keys);

  return NextResponse.json({ deleted: name });
}
