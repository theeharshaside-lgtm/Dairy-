/**
 * Daily Dairy - Comprehensive Automated E2E Test Suite
 * Tests full authentication, 2-device identity separation, viewing sessions,
 * and ephemeral auto-deletion lifecycle.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Clean isolated test database file before test run
const testDbFile = path.join(__dirname, 'data', 'test_diary.sqlite');
if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
if (fs.existsSync(testDbFile + '-wal')) fs.unlinkSync(testDbFile + '-wal');
if (fs.existsSync(testDbFile + '-shm')) fs.unlinkSync(testDbFile + '-shm');
process.env.DB_FILE = testDbFile;
process.env.PORT = '3099';

const app = require('./server');

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3099,
      path: path,
      method: method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('\n--- Starting Daily Dairy Automated Lifecycle Verification ---');

  // Test 1: Bad login rejected
  const badLogin = await makeRequest('POST', '/api/auth/login', {
    username: 'diary',
    password: 'WrongPassword123'
  });
  assert(badLogin.status === 401, 'Invalid password is rejected with 401');

  // Test 2: Bootstrap login succeeds and mandates password change
  const bootLogin = await makeRequest('POST', '/api/auth/login', {
    username: 'diary',
    password: 'ChangeThisOnFirstLogin!',
    deviceId: 'phone_test_1'
  });
  assert(bootLogin.status === 200 && bootLogin.body.success, 'Bootstrap login succeeds');
  assert(bootLogin.body.mustChangePassword === true, 'First login mandates password change');
  const tempToken = bootLogin.body.token;

  // Test 3: Change password
  const changeRes = await makeRequest('POST', '/api/auth/change-password', {
    newPassword: 'MySecureNotebookPass2026!'
  }, { 'Authorization': `Bearer ${tempToken}` });
  assert(changeRes.status === 200 && changeRes.body.success, 'Mandatory password change succeeds');

  // Test 4: Phone 1 login with new password
  const p1Login = await makeRequest('POST', '/api/auth/login', {
    username: 'diary',
    password: 'MySecureNotebookPass2026!',
    deviceId: 'phone_alpha_1'
  });
  assert(p1Login.status === 200 && p1Login.body.mustChangePassword === false, 'Phone 1 logs in with new password');
  const tokenP1 = p1Login.body.token;
  const devP1 = p1Login.body.deviceId;

  // Test 5: Phone 2 login with same account, separate device identity
  const p2Login = await makeRequest('POST', '/api/auth/login', {
    username: 'diary',
    password: 'MySecureNotebookPass2026!',
    deviceId: 'phone_beta_2'
  });
  assert(p2Login.status === 200, 'Phone 2 logs in successfully');
  const tokenP2 = p2Login.body.token;
  const devP2 = p2Login.body.deviceId;
  assert(devP1 !== devP2, 'Server maintains distinct device IDs for the two phones');

  // Test 6: Phone 1 posts an entry: "Hey, thinnava??"
  const postRes = await makeRequest('POST', '/api/entries', {
    id: 'entry_001',
    content: 'Hey, thinnava??',
    authorDeviceId: devP1,
    createdAt: Date.now()
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });
  assert(postRes.status === 200 && postRes.body.success, 'Phone 1 writes diary entry');

  // Test 7: Phone 2 fetches diary -> sees Phone 1's entry
  const p2Entries = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(p2Entries.body.length === 1, 'Phone 2 sees the written diary entry');
  assert(p2Entries.body[0].content === 'Hey, thinnava??', 'Entry content matches exactly');

  // Test 8: Phone 2 registers viewing session
  const viewRes = await makeRequest('POST', '/api/entries/view-session/start', {
    deviceId: devP2,
    entryIds: ['entry_001']
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(viewRes.status === 200, 'Phone 2 starts viewing session for entry');

  // Test 9: While viewing session is active, entry remains visible
  const activeCheck = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(activeCheck.body.length === 1, 'Entry remains displayed while Phone 2 is reading in the diary');

  // Test 10: Sender (Phone 1) exiting or calling consume does NOT delete their own entry
  const p1ConsumeRes = await makeRequest('POST', '/api/entries/consume', {
    deviceId: devP1,
    entryIds: ['entry_001']
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });
  assert(p1ConsumeRes.body.consumedCount === 0, 'Sender opening or leaving does NOT consume their own entry');

  // Verify entry is still active after sender action
  const checkStillActive = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP1}`,
    'X-Device-Id': devP1
  });
  assert(checkStillActive.body.length === 1, 'Entry still preserved after sender action');

  // Test 11: Phone 2 leaves the diary screen -> triggers atomic consume
  const p2ConsumeRes = await makeRequest('POST', '/api/entries/consume', {
    deviceId: devP2,
    entryIds: ['entry_001']
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(p2ConsumeRes.status === 200 && p2ConsumeRes.body.consumedCount === 1, 'Recipient exit consumes entry');

  // Test 12: Verify entry has completely vanished for BOTH phones
  const p1Final = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP1}`,
    'X-Device-Id': devP1
  });
  const p2Final = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(p1Final.body.length === 0, 'Entry disappeared from Phone 1');
  assert(p2Final.body.length === 0, 'Entry disappeared from Phone 2');

  // Test 13: Refresh does not restore consumed entry
  const refreshCheck = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(refreshCheck.body.length === 0, 'Refresh does not restore consumed entry');

  // Test 14: Selective consumption (Unread entries preserved)
  // Phone 1 writes two entries
  await makeRequest('POST', '/api/entries', {
    id: 'entry_read_me',
    content: 'Yes, thinna 😊',
    authorDeviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });

  await makeRequest('POST', '/api/entries', {
    id: 'entry_unread',
    content: 'Em chesthunnav ippudu?',
    authorDeviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });

  // Phone 2 views only 'entry_read_me'
  await makeRequest('POST', '/api/entries/view-session/start', {
    deviceId: devP2,
    entryIds: ['entry_read_me']
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });

  // Phone 2 exits and consumes ONLY 'entry_read_me'
  const partialConsume = await makeRequest('POST', '/api/entries/consume', {
    deviceId: devP2,
    entryIds: ['entry_read_me']
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });

  assert(partialConsume.body.consumedCount === 1, 'Only viewed entry is consumed');

  const afterPartial = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(afterPartial.body.length === 1, 'Unread entry is preserved');
  assert(afterPartial.body[0].id === 'entry_unread', 'Exact unread entry remains pending');

  // Test 15: Realtime Server-Sent Events (SSE) broadcast to Phone 2
  let sseReceived = false;
  let receivedEntry = null;

  const sseReq = http.request({
    hostname: '127.0.0.1',
    port: 3099,
    path: `/api/events?token=${tokenP2}&deviceId=${devP2}`,
    method: 'GET'
  }, (res) => {
    res.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('event: entry_created')) {
        const match = text.match(/data: (\{.*\})/);
        if (match) {
          sseReceived = true;
          receivedEntry = JSON.parse(match[1]);
        }
      }
    });
  });
  sseReq.end();

  // Wait for SSE handshake
  await new Promise(r => setTimeout(r, 200));

  // Phone 1 writes a new entry while Phone 2 is connected to SSE
  await makeRequest('POST', '/api/entries', {
    id: 'entry_realtime_001',
    content: 'Realtime test: Phone 1 wrote this instantly!',
    authorDeviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });

  // Wait 300ms for event to stream across
  await new Promise(r => setTimeout(r, 300));
  sseReq.destroy();

  assert(sseReceived === true, 'Phone 2 receives real-time SSE push broadcast when Phone 1 writes');
  assert(receivedEntry && receivedEntry.id === 'entry_realtime_001', 'Received entry matches written content');

  // Test 16: Dual simultaneous sessions remain valid
  const p1CheckSession = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP1}`,
    'X-Device-Id': devP1
  });
  const p2CheckSession = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(p1CheckSession.status === 200, 'Phone 1 session remains fully valid');
  assert(p2CheckSession.status === 200, 'Phone 2 session remains fully valid');

  // Test 17: Fetch public VAPID key for push notification registration
  const pushKeyRes = await makeRequest('GET', '/api/push/public-key', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  assert(pushKeyRes.status === 200 && pushKeyRes.body.success, 'Public VAPID key endpoint returns 200');
  assert(typeof pushKeyRes.body.publicKey === 'string' && pushKeyRes.body.publicKey.length > 30, 'Valid VAPID public key string returned');

  // Test 18: Phone 2 registers a push subscription
  const simulatedSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/simulated_token_phone2_' + Date.now(),
    keys: {
      p256dh: 'BCm5678_simulated_public_key_for_testing_purposes_only_p256dh_signature_sample_key',
      auth: 'simulated_auth_key'
    }
  };
  const subRes = await makeRequest('POST', '/api/push/subscribe', {
    subscription: simulatedSub,
    deviceId: devP2,
    recipientName: 'Honey'
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(subRes.status === 200 && subRes.body.success, 'Phone 2 registers push subscription with recipient name');

  // Test 19: Duplicate push subscription handling (idempotent update)
  const dupSubRes = await makeRequest('POST', '/api/push/subscribe', {
    subscription: simulatedSub,
    deviceId: devP2,
    recipientName: 'My Love'
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(dupSubRes.status === 200 && dupSubRes.body.success, 'Duplicate push subscription replaces cleanly without error');

  // Test 20: Phone 1 posts a voice note entry
  const voicePost = await makeRequest('POST', '/api/entries', {
    id: 'entry_voice_001',
    content: '[Voice Note]',
    entryType: 'voice',
    mediaUrl: 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAA==',
    authorDeviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });
  assert(voicePost.status === 200 && voicePost.body.success, 'Phone 1 creates voice note entry');

  // Verify Phone 2 can read the voice note entry
  const checkVoice = await makeRequest('GET', '/api/entries', null, {
    'Authorization': `Bearer ${tokenP2}`,
    'X-Device-Id': devP2
  });
  const voiceEntry = checkVoice.body.find(e => e.id === 'entry_voice_001');
  assert(voiceEntry && voiceEntry.entryType === 'voice', 'Phone 2 sees voice note entry with audio media');

  // Test 21: Phone 1 posts a photo attachment entry
  const photoPost = await makeRequest('POST', '/api/entries', {
    id: 'entry_photo_001',
    content: '[Photo attached]',
    entryType: 'attachment',
    mediaUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    authorDeviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });
  assert(photoPost.status === 200 && photoPost.body.success, 'Phone 1 creates attachment entry');

  // Test 22: Phone 2 unsubscribes from push notifications
  const unsubRes = await makeRequest('POST', '/api/push/unsubscribe', {
    endpoint: simulatedSub.endpoint
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(unsubRes.status === 200 && unsubRes.body.success, 'Phone 2 unsubscribes from push notifications');

  // Test 23: Phone 1 sends presence heartbeat (one user online)
  const p1Heartbeat = await makeRequest('POST', '/api/presence/heartbeat', {
    deviceId: devP1
  }, { 'Authorization': `Bearer ${tokenP1}`, 'X-Device-Id': devP1 });
  assert(p1Heartbeat.status === 200 && p1Heartbeat.body.presence.status === 'one_online', 'Phone 1 heartbeat sets status to one_online');

  // Test 24: Phone 2 sends presence heartbeat (both users online!)
  const p2Heartbeat = await makeRequest('POST', '/api/presence/heartbeat', {
    deviceId: devP2
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(p2Heartbeat.status === 200 && p2Heartbeat.body.presence.bothOnline === true && p2Heartbeat.body.presence.status === 'both_online', 'Both phones active sets status to both_online');

  // Test 25: Querying presence endpoint reflects both online
  const checkPresence = await makeRequest('GET', '/api/presence', null, {
    'Authorization': `Bearer ${tokenP1}`,
    'X-Device-Id': devP1
  });
  assert(checkPresence.body.presence.bothOnline === true && checkPresence.body.presence.status === 'both_online', 'Presence endpoint accurately reports both users online');

  // Test 26: Phone 2 sends leave signal -> status switches back to one_online
  const p2Leave = await makeRequest('POST', '/api/presence/leave', {
    deviceId: devP2
  }, { 'Authorization': `Bearer ${tokenP2}`, 'X-Device-Id': devP2 });
  assert(p2Leave.status === 200 && p2Leave.body.presence.bothOnline === false && p2Leave.body.presence.status === 'one_online', 'Phone 2 leaving sets status promptly back to one_online');

  console.log('\n🌟 ALL 26 AUTOMATED LIFECYCLE, REALTIME, MEDIA, PUSH & PRESENCE TESTS PASSED PERFECTLY!\n');
  process.exit(0);
}

// Wait 500ms for server to bind then run
setTimeout(runTests, 500);

