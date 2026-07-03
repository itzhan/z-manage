import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database;

const DB_PATH = process.env.DB_PATH || './data/z-manage.sqlite';

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initTables(db);
  migrateMailcomTokenColumns(db);
  migrateRegisteredExported(db);
  migrateOpenaiKeysSchema(db);
  seedAddresses(db);
  return db;
}

export function logAllocation(
  db: Database.Database,
  resource: string,
  action: string,
  keyName: string,
  count: number,
  detail?: Record<string, unknown>,
) {
  db.prepare(
    `INSERT INTO allocation_log (resource, action, keyName, count, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(resource, action, keyName, count, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_accounts (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      balance   REAL DEFAULT 0,
      currency  TEXT DEFAULT 'USD',
      note      TEXT,
      addedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id                      TEXT PRIMARY KEY,
      cardNumber              TEXT NOT NULL,
      expiry                  TEXT,
      cvv                     TEXT,
      brand                   TEXT,
      cardholder              TEXT,
      country                 TEXT,
      address1                TEXT,
      city                    TEXT,
      state                   TEXT,
      zip                     TEXT,
      accountId               TEXT REFERENCES payment_accounts(id),
      claudeUsedCount         INTEGER DEFAULT 0,
      claudeMaxUsage          INTEGER DEFAULT 1,
      codexUsedCount          INTEGER DEFAULT 0,
      codexMaxUsage           INTEGER DEFAULT 3,
      claudePlatformUsedCount INTEGER DEFAULT 0,
      claudePlatformMaxUsage  INTEGER DEFAULT 3,
      openaiPlatformUsedCount INTEGER DEFAULT 0,
      openaiPlatformMaxUsage  INTEGER DEFAULT 5,
      status                  TEXT DEFAULT 'active',
      allocatedTo             TEXT,
      allocatedAt             TEXT,
      deleted                 INTEGER DEFAULT 0,
      deletedAt               TEXT,
      addedAt                 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_cards_brand ON cards(brand);
    CREATE INDEX IF NOT EXISTS idx_cards_allocated ON cards(allocatedTo);

    CREATE TABLE IF NOT EXISTS codex_credentials (
      id                    TEXT PRIMARY KEY,
      email                 TEXT NOT NULL,
      accessToken           TEXT NOT NULL,
      chatgptAccountId      TEXT,
      expiresAt             TEXT,
      planType              TEXT,
      sourceAccountId       TEXT,
      sourceTemplateId      TEXT,
      sourceTemplateName    TEXT,
      usedInvites           INTEGER DEFAULT 0,
      maxInvites            INTEGER DEFAULT 3,
      invites               TEXT DEFAULT '[]',
      subscriptionExpiresAt TEXT,
      allocatedTo           TEXT,
      allocatedAt           TEXT,
      addedAt               TEXT NOT NULL,
      refreshedAt           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_codex_allocated ON codex_credentials(allocatedTo);

    CREATE TABLE IF NOT EXISTS mailcom_accounts (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      password     TEXT NOT NULL,
      tokenStatus  TEXT DEFAULT 'ok',
      tokenAt      TEXT,
      tokenError   TEXT,
      banned       INTEGER DEFAULT 0,
      mailBannedAt TEXT,
      mailPaidAt   TEXT,
      allocatedTo  TEXT,
      allocatedAt  TEXT,
      addedAt      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mailcom_allocated ON mailcom_accounts(allocatedTo);
    CREATE INDEX IF NOT EXISTS idx_mailcom_banned ON mailcom_accounts(banned);

    CREATE TABLE IF NOT EXISTS google_accounts (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      password        TEXT NOT NULL,
      recoveryEmail   TEXT,
      twoFaSecret     TEXT,
      used            INTEGER DEFAULT 0,
      captcha         INTEGER DEFAULT 0,
      abnormal        INTEGER DEFAULT 0,
      abnormal_reason TEXT,
      allocatedTo     TEXT,
      allocatedAt     TEXT,
      addedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_used ON google_accounts(used);
    CREATE INDEX IF NOT EXISTS idx_google_allocated ON google_accounts(allocatedTo);

    CREATE TABLE IF NOT EXISTS proxies (
      id               TEXT PRIMARY KEY,
      host             TEXT NOT NULL,
      port             TEXT NOT NULL,
      user             TEXT NOT NULL,
      pass             TEXT NOT NULL,
      region           TEXT DEFAULT 'us',
      pool             TEXT DEFAULT 'static',
      claudeUsed       INTEGER DEFAULT 0,
      claudeCount      INTEGER DEFAULT 0,
      openaiCount      INTEGER DEFAULT 0,
      openaiInUse      INTEGER DEFAULT 0,
      openaiInUseCount INTEGER DEFAULT 0,
      bad              INTEGER DEFAULT 0,
      bad_reason       TEXT,
      allocatedTo      TEXT,
      allocatedAt       TEXT,
      deleted          INTEGER DEFAULT 0,
      deletedAt        TEXT,
      addedAt          TEXT,
      UNIQUE(host, port)
    );
    CREATE INDEX IF NOT EXISTS idx_proxies_allocated ON proxies(allocatedTo);
    CREATE INDEX IF NOT EXISTS idx_proxies_region ON proxies(region);

    CREATE TABLE IF NOT EXISTS registered_accounts (
      email           TEXT PRIMARY KEY,
      status          TEXT DEFAULT 'registered',
      plan_type       TEXT,
      session_key     TEXT,
      platform        TEXT,
      registered_at   TEXT,
      paid_at         TEXT,
      authorized_at   TEXT,
      paid_card       TEXT,
      paid_card_brand TEXT,
      proxy_host      TEXT,
      google_email    TEXT,
      browser_id      TEXT,
      sourceKeyName   TEXT,
      uploadedAt      TEXT,
      exported        INTEGER DEFAULT 0,
      exportedAt      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_registered_status ON registered_accounts(status);
    CREATE INDEX IF NOT EXISTS idx_registered_source ON registered_accounts(sourceKeyName);

    CREATE TABLE IF NOT EXISTS openai_keys (
      id              TEXT PRIMARY KEY,
      email           TEXT,
      apiKey          TEXT,
      status          TEXT DEFAULT 'active',
      sourceKeyName   TEXT,
      uploadedAt      TEXT,
      exported        INTEGER DEFAULT 0,
      exportedAt      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_openai_source ON openai_keys(sourceKeyName);

    CREATE TABLE IF NOT EXISTS allocation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      keyName TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      detail TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_allocation_log_created ON allocation_log(createdAt);

    CREATE TABLE IF NOT EXISTS workers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      baseUrl        TEXT NOT NULL,
      token          TEXT NOT NULL DEFAULT '',
      status         TEXT DEFAULT 'offline',
      maxTasks       INTEGER DEFAULT 5,
      runningTasks   INTEGER DEFAULT 0,
      capabilities   TEXT DEFAULT '["claude-platform-bindcard","platform-bindcard"]',
      browserType    TEXT DEFAULT 'ads',
      lastHeartbeat  TEXT,
      systemInfo     TEXT,
      createdAt      TEXT NOT NULL,
      updatedAt      TEXT
    );

    CREATE TABLE IF NOT EXISTS dispatch_tasks (
      id             TEXT PRIMARY KEY,
      workerId       TEXT,
      action         TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      params         TEXT DEFAULT '{}',
      resources      TEXT DEFAULT '{}',
      result         TEXT,
      log            TEXT DEFAULT '',
      errorReason    TEXT,
      createdAt      TEXT NOT NULL,
      dispatchedAt   TEXT,
      finishedAt     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_worker ON dispatch_tasks(workerId);

    CREATE TABLE IF NOT EXISTS openai_pool (
      id             TEXT PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      password       TEXT,
      msRefreshToken TEXT,
      used           INTEGER DEFAULT 0,
      allocatedTo    TEXT,
      allocatedAt    TEXT,
      addedAt        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_openai_pool_allocated ON openai_pool(allocatedTo);

    CREATE TABLE IF NOT EXISTS addresses (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      address1 TEXT NOT NULL,
      city     TEXT NOT NULL,
      state    TEXT NOT NULL,
      zip      TEXT NOT NULL,
      used     INTEGER DEFAULT 0,
      addedAt  TEXT NOT NULL
    );
  `);
}

function migrateMailcomTokenColumns(db: Database.Database) {
  const cols = ['accessToken TEXT', 'refreshToken TEXT', 'sessionExpiresAt TEXT'];
  for (const col of cols) {
    try { db.exec(`ALTER TABLE mailcom_accounts ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

function migrateOpenaiKeysSchema(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(openai_keys)").all() as { name: string }[];
    if (cols.some((c) => c.name === 'oaiStatus')) {
      db.exec('DROP TABLE openai_keys');
      db.exec(`CREATE TABLE openai_keys (
        id TEXT PRIMARY KEY, email TEXT, apiKey TEXT, status TEXT DEFAULT 'active',
        sourceKeyName TEXT, uploadedAt TEXT, exported INTEGER DEFAULT 0, exportedAt TEXT
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_openai_source ON openai_keys(sourceKeyName)');
    }
  } catch { /* ignore */ }
}

function seedAddresses(db: Database.Database) {
  const count = (db.prepare('SELECT COUNT(*) as c FROM addresses').get() as any).c;
  if (count > 0) return;
  const seedPath = path.resolve('data/seed-addresses.json');
  if (!fs.existsSync(seedPath)) return;
  try {
    const items = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    const stmt = db.prepare('INSERT OR IGNORE INTO addresses (address1, city, state, zip, used, addedAt) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) {
        stmt.run(r.address1, r.city, r.state, r.zip, 0, r.addedAt || new Date().toISOString());
      }
    });
    tx(items);
  } catch { /* ignore seed errors */ }
}

function migrateRegisteredExported(db: Database.Database) {
  for (const tbl of ['registered_accounts', 'openai_keys']) {
    for (const col of ['exported INTEGER DEFAULT 0', 'exportedAt TEXT']) {
      try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_${tbl}_exported ON ${tbl}(exported)`); } catch { /* ignore */ }
  }
}
