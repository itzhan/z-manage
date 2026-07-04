import { getDb } from './db';

let timer: ReturnType<typeof setInterval> | null = null;
let lastLog = '';

function getConfig() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv_settings WHERE key = 'auto_push'").get() as any;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function saveLog(msg: string) {
  lastLog = msg;
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO kv_settings (key, value) VALUES ('auto_push_log', ?)").run(msg);
}

async function tick() {
  const cfg = getConfig();
  if (!cfg?.enabled) { stop(); return; }
  const hubUrl = (cfg.hubUrl || '').replace(/\/+$/, '');
  if (!hubUrl) { saveLog('错误: 未配置中枢地址'); return; }

  try {
    const db = getDb();
    const unexported = (db.prepare("SELECT COUNT(*) as c FROM registered_accounts WHERE (exported = 0 OR exported IS NULL) AND session_key IS NOT NULL AND session_key != ''").get() as any).c;

    if (unexported > 0) {
      saveLog(`发现 ${unexported} 个未导出，推送中...`);
      const rows = db.prepare("SELECT email, session_key FROM registered_accounts WHERE (exported = 0 OR exported IS NULL) AND session_key IS NOT NULL AND session_key != '' ORDER BY uploadedAt DESC LIMIT ?").all(unexported) as any[];
      const keys = rows.map(r => r.session_key);
      const target = hubUrl + '/api/keys';

      const resp = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      const data = await resp.json();

      if (resp.ok && data.success !== false) {
        const emails = rows.map(r => r.email);
        const placeholders = emails.map(() => '?').join(',');
        db.prepare(`UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`).run(new Date().toISOString(), ...emails);
        saveLog(`已推送 ${rows.length} 个，中枢新增 ${data.data?.added ?? '?'}，池中共 ${data.data?.total ?? '?'}`);
      } else {
        saveLog(`推送失败: ${data.error || '远端返回错误'}`);
      }
    } else {
      let poolInfo = '';
      try {
        const poolRes = await fetch(hubUrl + '/api/keys');
        const pd = await poolRes.json();
        if (pd.success) poolInfo = ` · 中枢池: ${pd.data.total}`;
      } catch { /* ignore */ }
      saveLog(`无未导出${poolInfo}`);
    }
  } catch (e: any) {
    saveLog(`错误: ${e.message}`);
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(tick, 5000);
  tick();
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isRunning() { return timer !== null; }

export function getStatus() {
  const cfg = getConfig();
  const db = getDb();
  const logRow = db.prepare("SELECT value FROM kv_settings WHERE key = 'auto_push_log'").get() as any;
  return {
    enabled: cfg?.enabled || false,
    hubUrl: cfg?.hubUrl || 'http://38.34.191.113:3104',
    running: isRunning(),
    log: logRow?.value || lastLog || '',
  };
}

export function setEnabled(enabled: boolean, hubUrl?: string) {
  const db = getDb();
  const current = getConfig() || {};
  const newCfg = { ...current, enabled, hubUrl: hubUrl ?? current.hubUrl ?? 'http://38.34.191.113:3104' };
  db.prepare("INSERT OR REPLACE INTO kv_settings (key, value) VALUES ('auto_push', ?)").run(JSON.stringify(newCfg));
  if (enabled) start(); else stop();
}

// Auto-start on module load if previously enabled
export function initAutoPush() {
  const cfg = getConfig();
  if (cfg?.enabled) start();
}
