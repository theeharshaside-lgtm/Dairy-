/**
 * Daily Dairy - Database Persistence Across Process Restarts Verification (@libsql/client)
 * Validates that libSQL / SQLite database files retain state across separate OS process executions.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const testDbFile = path.join(__dirname, 'data', 'test_restart_persist.sqlite');

function clean() {
  ['', '-wal', '-shm'].forEach(ext => {
    if (fs.existsSync(testDbFile + ext)) fs.unlinkSync(testDbFile + ext);
  });
}

clean();

async function runProcess(scriptCode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', scriptCode], {
      env: { ...process.env, DB_FILE: testDbFile, DB_URL: 'file:' + testDbFile },
      stdio: 'pipe'
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

async function verifyPersistenceAcrossRestarts() {
  console.log('\n--- Step 1: Starting Process A (Write data with @libsql/client & exit) ---');
  const procA = await runProcess(`
    const { createClient } = require('@libsql/client');
    async function main() {
      const client = createClient({ url: process.env.DB_URL });
      await client.execute('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT, status TEXT);');
      await client.execute('CREATE TABLE IF NOT EXISTS auth (username TEXT PRIMARY KEY, hash TEXT);');
      await client.execute({ sql: 'INSERT INTO entries VALUES (?, ?, ?);', args: ['e_persist_1', 'I love you across restarts', 'ACTIVE'] });
      await client.execute({ sql: 'INSERT INTO auth VALUES (?, ?);', args: ['diary', 'sample_hash_2026'] });
      await client.close();
      console.log('PROCESS_A_DONE');
    }
    main().catch(e => { console.error(e); process.exit(1); });
  `);

  assert.strictEqual(procA.code, 0, 'Process A exited cleanly');
  assert.ok(procA.stdout.includes('PROCESS_A_DONE'), 'Process A completed writes');
  console.log('✅ Process A completed and terminated.');

  console.log('\n--- Step 2: Verifying database file exists on disk ---');
  assert.ok(fs.existsSync(testDbFile), 'Database file exists on disk');
  console.log('✅ Database file verified at:', testDbFile);

  console.log('\n--- Step 3: Starting Process B (Independent process reading database with @libsql/client) ---');
  const procB = await runProcess(`
    const { createClient } = require('@libsql/client');
    async function main() {
      const client = createClient({ url: process.env.DB_URL });
      const entryRes = await client.execute({ sql: 'SELECT * FROM entries WHERE id = ?;', args: ['e_persist_1'] });
      const authRes = await client.execute({ sql: 'SELECT * FROM auth WHERE username = ?;', args: ['diary'] });
      await client.close();
      console.log('ENTRY_FOUND:' + JSON.stringify(entryRes.rows[0]));
      console.log('USER_FOUND:' + JSON.stringify(authRes.rows[0]));
    }
    main().catch(e => { console.error(e); process.exit(1); });
  `);

  assert.strictEqual(procB.code, 0, 'Process B exited cleanly');
  assert.ok(procB.stdout.includes('I love you across restarts'), 'Process B read the exact entry persisted by Process A');
  assert.ok(procB.stdout.includes('sample_hash_2026'), 'Process B read the exact credentials persisted by Process A');
  console.log('✅ Process B confirmed 100% data persistence across process restarts.');

  clean();
  console.log('\n🌟 PERSISTENCE ACROSS PROCESS RESTARTS CONFIRMED BY AUTOMATED DUAL-PROCESS TEST!\n');
}

verifyPersistenceAcrossRestarts().catch(err => {
  console.error('Persistence Test Error:', err);
  process.exit(1);
});
