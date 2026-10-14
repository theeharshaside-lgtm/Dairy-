const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push');

const app = express();

// Port resolution:
// In AI Studio internal container, Nginx listens on 8080 and proxies to 3000.
// In standard production hosting (Render, Railway, Fly.io, Cloud Run), PORT env var is respected directly.
const isAiStudioContainer = fs.existsSync('/app/control-plane-api');
let PORT = 3000;
if (process.env.PORT && process.env.PORT !== '8080') {
  PORT = parseInt(process.env.PORT, 10);
} else if (isAiStudioContainer) {
  PORT = parseInt(process.env.APP_PORT, 10) || 3000;
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

// Initialize Production SQLite Database
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS view_sessions (
    device_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, entry_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    recipient_name TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_push_device ON push_subscriptions(device_id);
`);

// Run graceful migrations on existing databases
try {
  db.exec("ALTER TABLE entries ADD COLUMN entry_type TEXT DEFAULT 'text';");
} catch (e) {
  // column already exists
}
try {
  db.exec("ALTER TABLE entries ADD COLUMN media_url TEXT;");
} catch (e) {
  // column already exists
}

// Prepared Statements
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1;');
const stmtInsertUser = db.prepare('INSERT INTO users (username, password_hash, must_change_password, updated_at) VALUES (?, ?, ?, ?);');
const stmtUpdatePassword = db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE username = ?;');

const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE token = ? LIMIT 1;');
const stmtInsertSession = db.prepare('INSERT OR REPLACE INTO sessions (token, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?);');
const stmtUpdateSessionSeen = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?;');

const stmtGetActiveEntries = db.prepare("SELECT id, author_device_id AS authorDeviceId, content, entry_type AS entryType, media_url AS mediaUrl, created_at AS createdAt, status FROM entries WHERE status IN ('ACTIVE', 'VIEWED') ORDER BY created_at ASC;");
const stmtGetEntryById = db.prepare('SELECT * FROM entries WHERE id = ? LIMIT 1;');
const stmtInsertEntry = db.prepare('INSERT OR IGNORE INTO entries (id, author_device_id, content, entry_type, media_url, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?);');
const stmtMarkEntryViewed = db.prepare("UPDATE entries SET status = 'VIEWED', viewed_by_device_id = ?, viewed_at = ? WHERE id = ? AND author_device_id != ? AND status = 'ACTIVE';");

const stmtInsertViewSession = db.prepare('INSERT OR REPLACE INTO view_sessions (device_id, entry_id, started_at) VALUES (?, ?, ?);');
const stmtGetViewSessionsForDevice = db.prepare('SELECT entry_id FROM view_sessions WHERE device_id = ?;');
const stmtDeleteViewSession = db.prepare('DELETE FROM view_sessions WHERE device_id = ? AND entry_id = ?;');
const stmtDeleteEntry = db.prepare('DELETE FROM entries WHERE id = ? AND author_device_id != ?;');
const stmtPurgeOrphanedViewed = db.prepare("DELETE FROM entries WHERE status = 'VIEWED' AND viewed_at IS NOT NULL AND viewed_at < ?;");

// Push Subscription Prepared Statements
const stmtInsertPushSub = db.prepare(`
  INSERT OR REPLACE INTO push_subscriptions 
    (endpoint, device_id, p256dh, auth, recipient_name, created_at, last_used_at) 
  VALUES (?, ?, ?, ?, ?, ?, ?);
`);
const stmtGetOtherPushSubs = db.prepare('SELECT * FROM push_subscriptions WHERE device_id != ?;');
const stmtGetDevicePushSubs = db.prepare('SELECT * FROM push_subscriptions WHERE device_id = ?;');
const stmtDeletePushSub = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?;');
const stmtUpdatePushSubUsed = db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?;');

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

// Seed or migrate data
function initDatabase() {
  const existingUser = stmtGetUser.get('diary');
  if (!existingUser) {
    // Check legacy JSON store if upgrading
    const legacyJson = path.join(DATA_DIR, 'diary_store.json');
    if (fs.existsSync(legacyJson)) {
      try {
        const raw = fs.readFileSync(legacyJson, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.user && parsed.user.passwordHash) {
          stmtInsertUser.run(
            parsed.user.username || 'diary',
            parsed.user.passwordHash,
            parsed.user.mustChangePassword ? 1 : 0,
            Date.now()
          );
          console.log('[Daily Dairy DB] Migrated user from legacy json store.');
        }
        if (parsed.entries && typeof parsed.entries === 'object') {
          for (const e of Object.values(parsed.entries)) {
            if (e.status === 'ACTIVE' || e.status === 'VIEWED') {
              stmtInsertEntry.run(e.id, e.authorDeviceId, e.content, e.entryType || 'text', e.mediaUrl || null, e.createdAt, e.status);
            }
          }
          console.log('[Daily Dairy DB] Migrated active entries from legacy json store.');
        }
      } catch (err) {
        console.warn('[Daily Dairy DB] Legacy migration notice:', err.message);
      }
    }

    // If still no user, insert default bootstrap credentials
    const checkAgain = stmtGetUser.get('diary');
    if (!checkAgain) {
      const defaultPass = process.env.BOOTSTRAP_PASSWORD || 'ChangeThisOnFirstLogin!';
      const salt = bcrypt.genSaltSync(12);
      const hash = bcrypt.hashSync(defaultPass, salt);
      stmtInsertUser.run('diary', hash, 1, Date.now());
      console.log('[Daily Dairy DB] Initialized with bootstrap credentials (diary / ChangeThisOnFirstLogin!)');
    }
  }
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

// Two-Person Server-Side Presence Engine
// Tracks deviceId -> { lastSeen: number, sseActive: boolean }
const activeDevices = new Map();
let lastBroadcastPresence = null;

function calculatePresence() {
  const now = Date.now();
  const OFFLINE_TIMEOUT_MS = 25000;
  const onlineDeviceIds = [];

  for (const [devId, info] of activeDevices.entries()) {
    if (now - info.lastSeen < OFFLINE_TIMEOUT_MS && info.sseActive !== false) {
      onlineDeviceIds.push(devId);
    }
  }

  // Two-person diary rule:
  // If 2 or more distinct devices are active -> both_online
  // If 1 device is active -> one_online
  // If 0 devices -> all_offline
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

// Private Push Notification Dispatcher (Discreet & Privacy-Guaranteed)
async function notifySubscribersOnNewEntry(entry) {
  const authorDeviceId = entry.authorDeviceId || entry.author_device_id;
  const entryType = entry.entryType || entry.entry_type || 'text';
  const entryId = entry.id;

  // Query registered push subscriptions belonging to devices OTHER than the sender
  let subscribers = [];
  try {
    subscribers = stmtGetOtherPushSubs.all(authorDeviceId);
  } catch (err) {
    console.warn('[Push] Error querying push subscribers:', err.message);
    return;
  }

  if (!subscribers || subscribers.length === 0) {
    return;
  }

  const deliveries = subscribers.map(async (sub) => {
    const recipientName = sub.recipient_name ? sub.recipient_name.trim() : '';

    // Privacy-safe defaults: NEVER expose entry text or attachment contents on lock screen
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
        TTL: 24 * 3600 // Expire in 24 hours if unreached
      });
      stmtUpdatePushSubUsed.run(Date.now(), sub.endpoint);
    } catch (err) {
      // 404 or 410 indicates expired or unregistered subscription: prune safely
      if (err.statusCode === 404 || err.statusCode === 410) {
        stmtDeletePushSub.run(sub.endpoint);
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
  contentSecurityPolicy: false // Allow inline SVG / stylesheet for rich notebook styling
}));
app.use(cors());
// Increased body limit to 15MB to comfortably support voice notes and media attachments
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
function requireAuth(req, res, next) {
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

  const session = stmtGetSession.get(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Session invalid or expired' });
  }

  stmtUpdateSessionSeen.run(Date.now(), token);
  req.session = session;
  req.deviceId = req.headers['x-device-id'] || req.query.deviceId || (req.body && req.body.deviceId) || session.device_id;
  next();
}

// --- API ROUTES ---

// Health & Persistence Diagnostic
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    database: 'sqlite_acid',
    push_configured: Boolean(vapidKeys && vapidKeys.publicKey),
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// 1. Login (supports simultaneous active devices under same account)
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password, deviceId } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  const user = stmtGetUser.get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const assignedDeviceId = deviceId || ('dev_' + crypto.randomBytes(8).toString('hex'));
  const now = Date.now();

  stmtInsertSession.run(token, assignedDeviceId, now, now);

  res.json({
    success: true,
    token: token,
    deviceId: assignedDeviceId,
    mustChangePassword: Boolean(user.must_change_password)
  });
});

// 2. Change Password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long' });
  }

  const salt = bcrypt.genSaltSync(12);
  const hash = bcrypt.hashSync(newPassword, salt);
  stmtUpdatePassword.run(hash, 0, Date.now(), 'diary');

  res.json({ success: true, message: 'Password updated successfully' });
});

// 3. Fetch Active Entries (Authoritative list from SQLite)
app.get('/api/entries', requireAuth, (req, res) => {
  const activeEntries = stmtGetActiveEntries.all();
  res.json(activeEntries);
});

// 4. Create Entry (Central authoritative store, Real-Time SSE & Push Delivery)
app.post('/api/entries', requireAuth, (req, res) => {
  const { id, content, authorDeviceId, createdAt, entryType, mediaUrl } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, error: 'Entry content is required' });
  }

  const cleanType = entryType || 'text';
  const cleanMedia = mediaUrl || null;

  const entryId = id || crypto.randomUUID();
  const devId = authorDeviceId || req.deviceId;
  const createdTimestamp = createdAt || Date.now();

  // Insert into SQLite database with ACID durability
  const existing = stmtGetEntryById.get(entryId);
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

  stmtInsertEntry.run(entryId, devId, content.trim(), cleanType, cleanMedia, createdTimestamp, 'ACTIVE');

  const newEntry = {
    id: entryId,
    authorDeviceId: devId,
    content: content.trim(),
    entryType: cleanType,
    mediaUrl: cleanMedia,
    createdAt: createdTimestamp,
    status: 'ACTIVE'
  };

  // Broadcast to other phone in real-time via SSE!
  broadcastSSE('entry_created', newEntry);

  // Dispatch private background push notification to recipient's phone
  notifySubscribersOnNewEntry(newEntry).catch(err => {
    console.warn('[Push] Background push error:', err.message);
  });

  res.json({ success: true, id: entryId, entry: newEntry });
});

// 5. Start/Report Viewing Session (When recipient is visibly reading on screen)
app.post('/api/entries/view-session/start', requireAuth, (req, res) => {
  const { deviceId, entryIds } = req.body;
  const currentDev = deviceId || req.deviceId;

  if (Array.isArray(entryIds)) {
    const now = Date.now();
    entryIds.forEach(id => {
      // Mark entry as VIEWED in SQLite if authored by the OTHER device
      stmtMarkEntryViewed.run(currentDev, now, id, currentDev);
      stmtInsertViewSession.run(currentDev, id, now);
    });
  }

  res.json({ success: true });
});

// 6. Consume/Delete Entries (Strict Read-and-Leave rule)
app.post('/api/entries/consume', requireAuth, (req, res) => {
  const { deviceId, entryIds } = req.body;
  const currentDev = deviceId || req.deviceId;

  let candidateIds = [];

  if (Array.isArray(entryIds) && entryIds.length > 0) {
    candidateIds = entryIds;
  } else {
    const rows = stmtGetViewSessionsForDevice.all(currentDev);
    candidateIds = rows.map(r => r.entry_id);
  }

  let consumedCount = 0;
  const deletedIds = [];

  // Atomic deletion of consumed entries authored by the other device
  candidateIds.forEach(id => {
    const entry = stmtGetEntryById.get(id);
    if (entry && entry.author_device_id !== currentDev) {
      stmtDeleteEntry.run(id, currentDev);
      stmtDeleteViewSession.run(currentDev, id);
      deletedIds.push(id);
      consumedCount++;
    }
  });

  if (consumedCount > 0) {
    // Broadcast real-time deletion to both devices
    broadcastSSE('entry_consumed', { consumedIds: deletedIds });
  }

  res.json({ success: true, consumedCount, consumedIds: deletedIds });
});

// 7. Real-Time Server-Sent Events (SSE) Stream
app.get('/api/events', requireAuth, (req, res) => {
  const clientId = crypto.randomUUID();
  const currentDev = req.deviceId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const activeEntries = stmtGetActiveEntries.all();
  res.write(`event: init\ndata: ${JSON.stringify(activeEntries)}\n\n`);

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

// Heartbeat from active PWA client
app.post('/api/presence/heartbeat', requireAuth, (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  const existing = activeDevices.get(currentDev) || { sseCount: 0 };
  activeDevices.set(currentDev, { ...existing, lastSeen: Date.now(), sseActive: true });
  checkAndBroadcastPresence();
  res.json({ success: true, presence: calculatePresence() });
});

// Explicit leave signal on background or exit
app.post('/api/presence/leave', requireAuth, (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  activeDevices.delete(currentDev);
  checkAndBroadcastPresence();
  res.json({ success: true, presence: calculatePresence() });
});

// Fetch current presence state
app.get('/api/presence', requireAuth, (req, res) => {
  res.json({ success: true, presence: calculatePresence() });
});

// --- PUSH NOTIFICATION API ENDPOINTS ---

// 8. Get Public VAPID Key (Authenticated)
app.get('/api/push/public-key', requireAuth, (req, res) => {
  res.json({
    success: true,
    publicKey: vapidKeys.publicKey
  });
});

// 9. Subscribe Device to Push Notifications
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription, deviceId, recipientName } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ success: false, error: 'Valid PushSubscription with p256dh and auth keys required' });
  }

  const currentDev = deviceId || req.deviceId;
  const cleanRecipientName = recipientName && typeof recipientName === 'string' ? recipientName.trim().substring(0, 50) : null;
  const now = Date.now();

  try {
    stmtInsertPushSub.run(
      subscription.endpoint,
      currentDev,
      subscription.keys.p256dh,
      subscription.keys.auth,
      cleanRecipientName,
      now,
      now
    );
    res.json({ success: true, message: 'Push subscription registered securely' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to record push subscription: ' + err.message });
  }
});

// 10. Unsubscribe Device from Push Notifications
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, error: 'Endpoint required' });
  }

  try {
    stmtDeletePushSub.run(endpoint);
    res.json({ success: true, message: 'Push subscription removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove push subscription: ' + err.message });
  }
});

// 11. Send Verified Test Notification to This Device
app.post('/api/push/test', requireAuth, async (req, res) => {
  const currentDev = req.body.deviceId || req.deviceId;
  const recipientName = req.body.recipientName ? req.body.recipientName.trim() : '';
  const subs = stmtGetDevicePushSubs.all(currentDev);

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
        stmtDeletePushSub.run(sub.endpoint);
      }
    }
  }

  res.json({ success: true, sentCount, message: `Dispatched test push to ${sentCount} device subscription(s).` });
});

// Auto-cleanup fallback: purge entries in VIEWED state for > 15 minutes
setInterval(() => {
  const cutoff = Date.now() - (15 * 60 * 1000);
  try {
    stmtPurgeOrphanedViewed.run(cutoff);
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

// Start Server
initDatabase();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(` Daily Dairy Production Backend (SQLite WAL)`);
  console.log(` Web Push Notifications Enabled (VAPID)`);
  console.log(` Listening on port ${PORT}`);
  console.log(`===============================================`);
});

module.exports = app;
