const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const webpush = require('web-push');

const app = express();

// Port resolution:
// In AI Studio internal container, Nginx listens on 8080 and proxies to 3000.
// In standard production hosting (Render, Railway, Fly.io, Cloud Run), PORT env var is respected directly.
const isAiStudioContainer = fs.existsSync('/app/control-plane-api');
let PORT = 3000;
if (isAiStudioContainer) {
  if (process.env.PORT && process.env.PORT !== '8080') {
    PORT = parseInt(process.env.PORT, 10);
  } else {
    PORT = parseInt(process.env.APP_PORT, 10) || 3000;
  }
} else if (process.env.PORT) {
  PORT = parseInt(process.env.PORT, 10);
} else if (process.env.APP_PORT) {
  PORT = parseInt(process.env.APP_PORT, 10);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'daily_dairy.sqlite');

// Database Connection:
// If TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set, connects to remote Turso Cloud SQLite.
// Otherwise, connects to local SQLite file for tests and offline development.
const isTurso = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
const dbUrl = isTurso ? process.env.TURSO_DATABASE_URL : (process.env.DB_URL || `file:${DB_FILE}`);

const dbClient = createClient({
  url: dbUrl,
  authToken: isTurso ? process.env.TURSO_AUTH_TOKEN : undefined
});

if (isTurso) {
  console.log('[Daily Dairy DB] Configured with Turso Cloud SQLite Database.');
} else {
  console.log(`[Daily Dairy DB] Configured with local SQLite file: ${dbUrl}`);
}

// Database Initialization & Migrations
async function initDatabase() {
  try {
    await dbClient.execute('PRAGMA foreign_keys = ON;').catch(() => {});

    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);

    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);

    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        author_device_id TEXT NOT NULL,
        content TEXT NOT NULL,
        entry_type TEXT NOT NULL DEFAULT 'text',
        media_url TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        viewed_by_device_id TEXT,
        viewed_at INTEGER,
        consumed_at INTEGER
      );
    `);

    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS view_sessions (
        device_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, entry_id)
      );
    `);

    await dbClient.execute(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        recipient_name TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
    `);

    await dbClient.execute('CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status, created_at);');
    await dbClient.execute('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);');
    await dbClient.execute('CREATE INDEX IF NOT EXISTS idx_push_device ON push_subscriptions(device_id);');

    // Safe Non-destructive Migrations
    try {
      await dbClient.execute("ALTER TABLE entries ADD COLUMN entry_type TEXT DEFAULT 'text';");
    } catch (e) {
      // Column already exists
    }
    try {
      await dbClient.execute("ALTER TABLE entries ADD COLUMN media_url TEXT;");
    } catch (e) {
      // Column already exists
    }

    // Seed or migrate bootstrap credentials
    const existingUserRes = await dbClient.execute({
      sql: 'SELECT * FROM users WHERE username = ? LIMIT 1;',
      args: ['diary']
    });

    if (existingUserRes.rows.length === 0) {
      // Check legacy JSON store if upgrading
      const legacyJson = path.join(DATA_DIR, 'diary_store.json');
      if (fs.existsSync(legacyJson)) {
        try {
          const raw = fs.readFileSync(legacyJson, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed.user && parsed.user.passwordHash) {
            await dbClient.execute({
              sql: 'INSERT INTO users (username, password_hash, must_change_password, updated_at) VALUES (?, ?, ?, ?);',
              args: [
                parsed.user.username || 'diary',
                parsed.user.passwordHash,
                parsed.user.mustChangePassword ? 1 : 0,
                Date.now()
              ]
            });
            console.log('[Daily Dairy DB] Migrated user from legacy json store.');
          }
          if (parsed.entries && typeof parsed.entries === 'object') {
            for (const e of Object.values(parsed.entries)) {
              if (e.status === 'ACTIVE' || e.status === 'VIEWED') {
                await dbClient.execute({
                  sql: 'INSERT OR IGNORE INTO entries (id, author_device_id, content, entry_type, media_url, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?);',
                  args: [e.id, e.authorDeviceId, e.content, e.entryType || 'text', e.mediaUrl || null, e.createdAt, e.status]
                });
              }
            }
            console.log('[Daily Dairy DB] Migrated active entries from legacy json store.');
          }
        } catch (err) {
          console.warn('[Daily Dairy DB] Legacy migration notice:', err.message);
        }
      }

      // Check again after legacy migration attempt
      const checkAgain = await dbClient.execute({
        sql: 'SELECT * FROM users WHERE username = ? LIMIT 1;',
        args: ['diary']
      });

      if (checkAgain.rows.length === 0) {
        const defaultPass = process.env.BOOTSTRAP_PASSWORD || 'ChangeThisOnFirstLogin!';
        const salt = bcrypt.genSaltSync(12);
        const hash = bcrypt.hashSync(defaultPass, salt);
        await dbClient.execute({
          sql: 'INSERT INTO users (username, password_hash, must_change_password, updated_at) VALUES (?, ?, ?, ?);',
          args: ['diary', hash, 1, Date.now()]
        });
        if (process.env.NODE_ENV === 'production' && !process.env.BOOTSTRAP_PASSWORD) {
          console.warn('[Daily Dairy Security] WARNING: Initialized bootstrap account with default password. Mandating immediate password change on first login.');
        } else {
          console.log('[Daily Dairy DB] Initialized bootstrap account (mandatory password change on first login enabled).');
        }
      }
    }
  } catch (err) {
    console.error('[Daily Dairy DB] Critical error initializing database schema:', err.message);
    throw err;
  }
}

// Setup Web Push VAPID Configuration
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid_keys.json');
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf8'));
    } catch (err) {
      console.warn('[Push] Error reading vapid_keys.json, regenerating:', err.message);
    }
  }
  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webpush.generateVAPIDKeys();
    try {
      fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
      console.log('[Push] Generated and persisted new VAPID keys to', VAPID_KEYS_FILE);
    } catch (err) {
      console.warn('[Push] Warning writing vapid_keys.json:', err.message);
    }
  }
}

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@dailydairy.app';
try {
  webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (err) {
  console.warn('[Push] Failed to initialize VAPID details:', err.message);
}

// Real-Time Server-Sent Events (SSE) Broadcast Engine
const sseClients = new Map(); // clientId -> { res, deviceId }

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, client] of sseClients.entries()) {
    try {
      client.res.write(payload);
    } catch (e) {
      sseClients.delete(clientId);
    }
  }
}

// Presence State Engine
const activeDevices = new Map(); // deviceId -> { lastSeen, sseCount, sseActive }
const OFFLINE_TIMEOUT_MS = 25000;
let lastBroadcastPresence = null;

function calculatePresence() {
  const now = Date.now();
  const onlineDeviceIds = [];

  for (const [devId, info] of activeDevices.entries()) {
    if (now - info.lastSeen < OFFLINE_TIMEOUT_MS && info.sseActive !== false) {
      onlineDeviceIds.push(devId);
    }
  }

  const bothOnline = onlineDeviceIds.length >= 2;
  const status = bothOnline ? 'both_online' : (onlineDeviceIds.length === 1 ? 'one_online' : 'all_offline');

  return {
    bothOnline,
    onlineCount: onlineDeviceIds.length,
    onlineDevices: onlineDeviceIds,
    status
  };
}

function checkAndBroadcastPresence() {
  const current = calculatePresence();
  if (!lastBroadcastPresence || 
      lastBroadcastPresence.bothOnline !== current.bothOnline || 
      lastBroadcastPresence.onlineCount !== current.onlineCount ||
      lastBroadcastPresence.status !== current.status) {
    lastBroadcastPresence = current;
    broadcastSSE('presence_change', current);
  }
}

// Periodic cleanup of stale presence
setInterval(() => {
  checkAndBroadcastPresence();
}, 4000);

// Private Push Notification Dispatcher
async function notifySubscribersOnNewEntry(entry) {
  const authorDeviceId = entry.authorDeviceId || entry.author_device_id;
  const entryType = entry.entryType || entry.entry_type || 'text';
  const entryId = entry.id;

  let subscribers = [];
  try {
    const subRes = await dbClient.execute({
      sql: 'SELECT * FROM push_subscriptions WHERE device_id != ?;',
      args: [authorDeviceId]
    });
    subscribers = subRes.rows;
  } catch (err) {
    console.warn('[Push] Error querying push subscribers:', err.message);
    return;
  }

  if (!subscribers || subscribers.length === 0) {
    return;
  }

  const deliveries = subscribers.map(async (sub) => {
    const recipientName = sub.recipient_name ? sub.recipient_name.trim() : '';

    let title = 'Daily Dairy ❤️ — You have a new entry.';
    let body = 'A private entry was added to your shared notebook.';

    if (entryType === 'voice') {
      title = recipientName ? `${recipientName}, you have a new voice note` : 'Daily Dairy ❤️ — You have a new voice note.';
      body = 'A voice note was added to your shared notebook.';
    } else if (entryType === 'attachment' || entryType === 'video' || entryType === 'file' || entryType === 'photo') {
      title = recipientName ? `${recipientName}, you have a new attachment` : 'Daily Dairy ❤️ — You have a new attachment.';
      body = 'An attachment was added to your shared notebook.';
    } else {
      if (recipientName) {
        title = `${recipientName}, you have a new entry`;
      }
    }

    const payload = JSON.stringify({
      title,
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'entry_' + entryId,
      data: {
        url: '/',
        entryId: entryId
      }
    });

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      await webpush.sendNotification(pushSubscription, payload, {
        TTL: 24 * 3600
      });
      await dbClient.execute({
        sql: 'UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?;',
        args: [Date.now(), sub.endpoint]
      });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await dbClient.execute({
          sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?;',
          args: [sub.endpoint]
        }).catch(() => {});
        console.log('[Push] Pruned expired push subscription for endpoint:', sub.endpoint.substring(0, 32));
      } else {
        console.warn('[Push] Notification dispatch note:', err.statusCode || err.message);
      }
    }
  });

  await Promise.allSettled(deliveries);
}

// Trust reverse proxy (Nginx / Cloud Run) for accurate IP resolution
app.set('trust proxy', 1);

// Security Headers & CORS
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.text({ type: ['text/plain', 'application/json'], limit: '1mb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {}
  }
  next();
});

// Rate limiting for authentication endpoint
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, trustProxy: false },
  message: { success: false, error: 'Too many login attempts. Please wait 1 minute.' }
});

// Authentication Middleware
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  } else if (req.body && typeof req.body === 'object' && req.body.token) {
    token = req.body.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Missing token' });
  }

  try {
    const sessionRes = await dbClient.execute({
      sql: 'SELECT * FROM sessions WHERE token = ? LIMIT 1;',
      args: [token]
    });
    const session = sessionRes.rows[0];
    if (!session) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Session invalid or expired' });
    }

    await dbClient.execute({
      sql: 'UPDATE sessions SET last_seen_at = ? WHERE token = ?;',
      args: [Date.now(), token]
    });

    req.session = session;
    req.deviceId = req.headers['x-device-id'] || req.query.deviceId || (req.body && req.body.deviceId) || session.device_id;
    next();
  } catch (err) {
    console.error('[Daily Dairy Auth] Session check error:', err.message);
    res.status(500).json({ success: false, error: 'Internal authentication error' });
  }
}

// --- API ROUTES ---

// Health & Persistence Diagnostic (Cloud LB / Render / Container monitor)
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    await dbClient.execute('SELECT 1 as alive;');
    res.json({
      status: 'healthy',
      ok: true,
      service: 'daily-dairy',
      database: isTurso ? 'turso_cloud_libsql' : 'sqlite_libsql_acid',
      push_configured: Boolean(vapidKeys && vapidKeys.publicKey),
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      ok: false,
      service: 'daily-dairy',
      error: 'Database check failed: ' + err.message,
      timestamp: Date.now()
    });
  }
});

// 1. Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, deviceId } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  try {
    const userRes = await dbClient.execute({
      sql: 'SELECT * FROM users WHERE username = ? LIMIT 1;',
      args: [username.trim()]
    });
    const user = userRes.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const assignedDeviceId = deviceId || ('dev_' + crypto.randomBytes(8).toString('hex'));
    const now = Date.now();

    await dbClient.execute({
      sql: 'INSERT OR REPLACE INTO sessions (token, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?);',
      args: [token, assignedDeviceId, now, now]
    });

    res.json({
      success: true,
      token: token,
      deviceId: assignedDeviceId,
      mustChangePassword: Boolean(user.must_change_password)
    });
  } catch (err) {
    console.error('[Daily Dairy Auth] Login error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error during login' });
  }
});

// 2. Change Password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long' });
  }

  const salt = bcrypt.genSaltSync(12);
  const hash = bcrypt.hashSync(newPassword, salt);
  try {
    await dbClient.execute({
      sql: 'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE username = ?;',
      args: [hash, Date.now(), 'diary']
    });
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update password' });
  }
});

// 3. Fetch Active Entries
app.get('/api/entries', requireAuth, async (req, res) => {
  try {
    const rs = await dbClient.execute("SELECT id, author_device_id AS authorDeviceId, content, entry_type AS entryType, media_url AS mediaUrl, created_at AS createdAt, status FROM entries WHERE status IN ('ACTIVE', 'VIEWED') ORDER BY created_at ASC;");
    res.json(rs.rows);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve entries: ' + err.message });
  }
});

// 4. Create Entry
app.post('/api/entries', requireAuth, async (req, res) => {
  const { id, content, authorDeviceId, createdAt, entryType, mediaUrl } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, error: 'Entry content is required' });
  }

  const cleanType = entryType || 'text';
  const cleanMedia = mediaUrl || null;
  const entryId = id || crypto.randomUUID();
  const devId = authorDeviceId || req.deviceId;
  const createdTimestamp = createdAt || Date.now();

  try {
    const existingRes = await dbClient.execute({
      sql: 'SELECT * FROM entries WHERE id = ? LIMIT 1;',
      args: [entryId]
    });
    const existing = existingRes.rows[0];
    if (existing) {
      return res.json({
        success: true,
        id: entryId,
        entry: {
          id: existing.id,
          authorDeviceId: existing.author_device_id,
          content: existing.content,
          entryType: existing.entry_type || 'text',
          mediaUrl: existing.media_url || null,
          createdAt: existing.created_at,
          status: existing.status
        },
        deduplicated: true
      });
    }

    await dbClient.execute({
      sql: 'INSERT INTO entries (id, author_device_id, content, entry_type, media_url, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?);',
      args: [entryId, devId, content.trim(), cleanType, cleanMedia, createdTimestamp, 'ACTIVE']
    });

    const newEntry = {
      id: entryId,
      authorDeviceId: devId,
      content: content.trim(),
      entryType: cleanType,
      mediaUrl: cleanMedia,
      createdAt: createdTimestamp,
      status: 'ACTIVE'
    };

    broadcastSSE('entry_created', newEntry);

    notifySubscribersOnNewEntry(newEntry).catch(err => {
      console.warn('[Push] Background push error:', err.message);
    });

    res.json({ success: true, id: entryId, entry: newEntry });
  } catch (err) {
    console.error('[Daily Dairy DB] Entry creation error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create entry' });
  }
});

// 5. Start/Report Viewing Session
app.post('/api/entries/view-session/start', requireAuth, async (req, res) => {
  const { deviceId, entryIds } = req.body;
  const currentDev = deviceId || req.deviceId;

  if (Array.isArray(entryIds) && entryIds.length > 0) {
    const now = Date.now();
    const batch = [];
    entryIds.forEach(id => {
      batch.push({
        sql: "UPDATE entries SET status = 'VIEWED', viewed_by_device_id = ?, viewed_at = ? WHERE id = ? AND author_device_id != ? AND status = 'ACTIVE';",
        args: [currentDev, now, id, currentDev]
      });
      batch.push({
        sql: 'INSERT OR REPLACE INTO view_sessions (device_id, entry_id, started_at) VALUES (?, ?, ?);',
        args: [currentDev, id, now]
      });
    });
    try {
      await dbClient.batch(batch, 'write');
    } catch (err) {
      console.warn('[Daily Dairy DB] View session update error:', err.message);
    }
  }

  res.json({ success: true });
});

// 6. Consume/Delete Entries (Atomic Read-and-Leave rule)
app.post('/api/entries/consume', requireAuth, async (req, res) => {
  const { deviceId, entryIds } = req.body;
  const currentDev = deviceId || req.deviceId;

  let candidateIds = [];

  if (Array.isArray(entryIds) && entryIds.length > 0) {
    candidateIds = entryIds;
  } else {
    try {
      const viewRows = await dbClient.execute({
        sql: 'SELECT entry_id FROM view_sessions WHERE device_id = ?;',
        args: [currentDev]
      });
      candidateIds = viewRows.rows.map(r => r.entry_id);
    } catch (err) {
      console.error('[Daily Dairy DB] Error fetching view sessions:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to query view sessions' });
    }
  }

  if (candidateIds.length === 0) {
    return res.json({ success: true, consumedCount: 0, consumedIds: [] });
  }

  const batchStatements = [];
  const deletedIds = [];

  for (const id of candidateIds) {
    try {
      const entryRes = await dbClient.execute({
        sql: 'SELECT * FROM entries WHERE id = ? LIMIT 1;',
        args: [id]
      });
      const entry = entryRes.rows[0];
      // SENDER IMMUNITY: Recipient only consumes entries authored by the other device!
      if (entry && entry.author_device_id !== currentDev) {
        batchStatements.push({
          sql: 'DELETE FROM entries WHERE id = ? AND author_device_id != ?;',
          args: [id, currentDev]
        });
        batchStatements.push({
          sql: 'DELETE FROM view_sessions WHERE device_id = ? AND entry_id = ?;',
          args: [currentDev, id]
        });
        deletedIds.push(id);
      }
    } catch (err) {
      console.warn('[Daily Dairy DB] Error checking entry during consume:', err.message);
    }
  }

  if (batchStatements.length > 0) {
    try {
      await dbClient.batch(batchStatements, 'write');
      broadcastSSE('entry_consumed', { consumedIds: deletedIds });
    } catch (err) {
      console.error('[Daily Dairy DB] Error in atomic consume batch transaction:', err.message);
      return res.status(500).json({ success: false, error: 'Database transaction error during consume' });
    }
  }

  res.json({ success: true, consumedCount: deletedIds.length, consumedIds: deletedIds });
});

// 7. Real-Time Server-Sent Events (SSE) Stream
app.get('/api/events', requireAuth, async (req, res) => {
  const clientId = crypto.randomUUID();
  const currentDev = req.deviceId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  try {
    const rs = await dbClient.execute("SELECT id, author_device_id AS authorDeviceId, content, entry_type AS entryType, media_url AS mediaUrl, created_at AS createdAt, status FROM entries WHERE status IN ('ACTIVE', 'VIEWED') ORDER BY created_at ASC;");
    res.write(`event: init\ndata: ${JSON.stringify(rs.rows)}\n\n`);
  } catch (err) {
    res.write(`event: init\ndata: []\n\n`);
  }

  // Register device presence
  const existing = activeDevices.get(currentDev) || { sseCount: 0 };
  activeDevices.set(currentDev, { lastSeen: Date.now(), sseCount: existing.sseCount + 1, sseActive: true });
  checkAndBroadcastPresence();

  // Send current presence immediately to connecting client
  res.write(`event: presence\ndata: ${JSON.stringify(calculatePresence())}\n\n`);

  sseClients.set(clientId, { res, deviceId: currentDev });

  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
      const dev = activeDevices.get(currentDev);
      if (dev) {
        dev.lastSeen = Date.now();
      }
    } catch (e) {
      clearInterval(pingInterval);
      sseClients.delete(clientId);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(clientId);
    const curr = activeDevices.get(currentDev);
    if (curr) {
      curr.sseCount = Math.max(0, (curr.sseCount || 1) - 1);
      if (curr.sseCount === 0) {
        curr.sseActive = false;
      }
    }
    checkAndBroadcastPresence();
  });
});

// --- TWO-PERSON PRESENCE API ENDPOINTS ---

app.post('/api/presence/heartbeat', requireAuth, (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  const existing = activeDevices.get(currentDev) || { sseCount: 0 };
  activeDevices.set(currentDev, { ...existing, lastSeen: Date.now(), sseActive: true });
  checkAndBroadcastPresence();
  res.json({ success: true, presence: calculatePresence() });
});

app.post('/api/presence/leave', requireAuth, (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  activeDevices.delete(currentDev);
  checkAndBroadcastPresence();
  res.json({ success: true, presence: calculatePresence() });
});

app.get('/api/presence', requireAuth, (req, res) => {
  res.json({ success: true, presence: calculatePresence() });
});

// --- PUSH NOTIFICATION API ENDPOINTS ---

app.get('/api/push/public-key', requireAuth, (req, res) => {
  res.json({
    success: true,
    publicKey: vapidKeys.publicKey
  });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription, deviceId, recipientName } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ success: false, error: 'Valid PushSubscription with p256dh and auth keys required' });
  }

  const currentDev = deviceId || req.deviceId;
  const cleanRecipientName = recipientName && typeof recipientName === 'string' ? recipientName.trim().substring(0, 50) : null;
  const now = Date.now();

  try {
    await dbClient.execute({
      sql: `
        INSERT OR REPLACE INTO push_subscriptions 
          (endpoint, device_id, p256dh, auth, recipient_name, created_at, last_used_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
      args: [subscription.endpoint, currentDev, subscription.keys.p256dh, subscription.keys.auth, cleanRecipientName, now, now]
    });
    res.json({ success: true, message: 'Push notification subscription registered successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save push subscription: ' + err.message });
  }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, error: 'Subscription endpoint required' });
  }

  try {
    await dbClient.execute({
      sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?;',
      args: [endpoint]
    });
    res.json({ success: true, message: 'Push subscription removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove push subscription: ' + err.message });
  }
});

app.post('/api/push/test', requireAuth, async (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  const recipientName = req.body.recipientName ? req.body.recipientName.trim() : '';

  try {
    const subRes = await dbClient.execute({
      sql: 'SELECT * FROM push_subscriptions WHERE device_id = ?;',
      args: [currentDev]
    });
    const subs = subRes.rows;

    if (!subs || subs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No active push subscription registered on this device yet. Please enable push notifications first.'
      });
    }

    let sentCount = 0;
    for (const sub of subs) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      const title = recipientName ? `${recipientName}, test from Daily Dairy ❤️` : 'Daily Dairy ❤️ — Test notification';
      const payload = JSON.stringify({
        title,
        body: 'Private push notifications are active on this phone.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'test_' + Date.now(),
        data: { url: '/' }
      });

      try {
        await webpush.sendNotification(pushSubscription, payload, { TTL: 60 });
        sentCount++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await dbClient.execute({
            sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?;',
            args: [sub.endpoint]
          }).catch(() => {});
        }
      }
    }

    res.json({ success: true, sentCount, message: `Dispatched test push to ${sentCount} device subscription(s).` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Test push failed: ' + err.message });
  }
});

// 12. Backup & Export Endpoint (Authenticated)
app.get('/api/entries/export-backup', requireAuth, async (req, res) => {
  try {
    const rs = await dbClient.execute("SELECT id, author_device_id AS authorDeviceId, content, entry_type AS entryType, media_url AS mediaUrl, created_at AS createdAt, status FROM entries WHERE status IN ('ACTIVE', 'VIEWED') ORDER BY created_at ASC;");
    const entries = rs.rows;
    const backupData = {
      version: '1.0.0',
      exportedAt: Date.now(),
      exportedByDevice: req.deviceId,
      totalEntries: entries.length,
      entries: entries
    };
    res.setHeader('Content-Disposition', `attachment; filename="daily_dairy_backup_${Date.now()}.json"`);
    res.json(backupData);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to generate backup export: ' + err.message });
  }
});

// Auto-cleanup fallback: purge entries in VIEWED state for > 15 minutes
setInterval(async () => {
  const cutoff = Date.now() - (15 * 60 * 1000);
  try {
    await dbClient.execute({
      sql: "DELETE FROM entries WHERE status = 'VIEWED' AND viewed_at IS NOT NULL AND viewed_at < ?;",
      args: [cutoff]
    });
  } catch (err) {
    // Handled safely
  }
}, 5 * 60 * 1000);

// Serve PWA client
const PWA_DIR = path.join(__dirname, '..', 'pwa');
if (fs.existsSync(PWA_DIR)) {
  app.use(express.static(PWA_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PWA_DIR, 'index.html'));
  });
}

// Graceful Shutdown
async function handleGracefulShutdown(signal) {
  console.log(`[Daily Dairy] Received ${signal}. Closing database connection...`);
  try {
    await dbClient.close();
    console.log('[Daily Dairy DB] Database safely closed.');
  } catch (e) {
    console.warn('[Daily Dairy DB] Note during database close:', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

// Start Server
const readyPromise = initDatabase().then(() => {
  return new Promise((resolve) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`===============================================`);
      console.log(` Daily Dairy Production Backend (Turso / libSQL)`);
      console.log(` Web Push Notifications Enabled (VAPID)`);
      console.log(` Listening on 0.0.0.0:${PORT}`);
      console.log(`===============================================`);
      resolve();
    });
  });
}).catch(err => {
  console.error('[Daily Dairy Server] Failed to initialize database on startup:', err);
  process.exit(1);
});

app.readyPromise = readyPromise;
module.exports = app;
