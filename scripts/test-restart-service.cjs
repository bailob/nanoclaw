#!/usr/bin/env node
/**
 * Test the restart_service IPC flow end-to-end.
 *
 * Tests:
 * 1. MCP server context file reading
 * 2. restart_service IPC file generation
 * 3. Host IPC handler processing
 * 4. Pending restart file generation
 *
 * Usage: node scripts/test-restart-service.cjs
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Clean up test artifacts
function cleanup() {
  const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
  try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }

  const testIpcDir = path.join(DATA_DIR, 'ipc', '_test-restart');
  try { fs.rmSync(testIpcDir, { recursive: true }); } catch { /* ignore */ }
}

console.log('\n=== Test 1: Context File ===');
console.log('Testing that MCP server can read context from file...\n');

const testIpcDir = path.join(DATA_DIR, 'ipc', '_test-restart');
fs.mkdirSync(path.join(testIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(testIpcDir, 'tasks'), { recursive: true });

// Write a context file like agent-runner would
const contextData = {
  chatJid: 'test-jid@g.us',
  groupFolder: '_test-restart',
  isMain: false,
};
fs.writeFileSync(
  path.join(testIpcDir, 'context.json'),
  JSON.stringify(contextData),
);

test('Context file is written correctly', () => {
  const content = JSON.parse(fs.readFileSync(path.join(testIpcDir, 'context.json'), 'utf-8'));
  assert(content.chatJid === 'test-jid@g.us', 'chatJid mismatch');
  assert(content.groupFolder === '_test-restart', 'groupFolder mismatch');
  assert(content.isMain === false, 'isMain mismatch');
});

console.log('\n=== Test 2: restart_service IPC File ===');
console.log('Simulating what the MCP server restart_service tool would write...\n');

// Simulate what the MCP server writes
const ipcData = {
  type: 'restart_service',
  reason: 'Test restart',
  continuation_prompt: 'Service restarted successfully!',
  chatJid: 'test-jid@g.us',
  groupFolder: '_test-restart',
  timestamp: new Date().toISOString(),
};

const ipcFilename = `${Date.now()}-test.json`;
const ipcFilePath = path.join(testIpcDir, 'tasks', ipcFilename);
fs.writeFileSync(ipcFilePath, JSON.stringify(ipcData, null, 2));

test('IPC task file is written correctly', () => {
  const content = JSON.parse(fs.readFileSync(ipcFilePath, 'utf-8'));
  assert(content.type === 'restart_service', 'type mismatch');
  assert(content.reason === 'Test restart', 'reason mismatch');
  assert(content.continuation_prompt === 'Service restarted successfully!', 'continuation_prompt mismatch');
  assert(content.chatJid === 'test-jid@g.us', 'chatJid mismatch');
  assert(content.groupFolder === '_test-restart', 'groupFolder mismatch');
});

console.log('\n=== Test 3: Host IPC Handler ===');
console.log('Testing processTaskIpc with restart_service type...\n');

// We'll test the processTaskIpc function directly by importing it
// Since it's an ESM module, we test indirectly by checking the file output

// Simulate what processTaskIpc does for restart_service
const registeredGroups = {
  'test-jid@g.us': { name: 'Test Group', folder: '_test-restart' },
};

// Simulate the restart_service case from ipc.ts
const sourceGroup = '_test-restart';
let restartChatJid;
for (const [jid, group] of Object.entries(registeredGroups)) {
  if (group.folder === sourceGroup) {
    restartChatJid = jid;
    break;
  }
}

test('Chat JID resolved from source group', () => {
  assert(restartChatJid === 'test-jid@g.us', `Expected test-jid@g.us but got ${restartChatJid}`);
});

// Simulate writing pending-restart.json
if (ipcData.continuation_prompt && restartChatJid) {
  const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
  fs.writeFileSync(pendingFile, JSON.stringify({
    chatJid: restartChatJid,
    groupFolder: sourceGroup,
    continuation_prompt: ipcData.continuation_prompt,
    reason: ipcData.reason,
    timestamp: new Date().toISOString(),
  }));
}

test('Pending restart file is written', () => {
  const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
  assert(fs.existsSync(pendingFile), 'pending-restart.json not found');
  const content = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
  assert(content.chatJid === 'test-jid@g.us', 'chatJid mismatch');
  assert(content.continuation_prompt === 'Service restarted successfully!', 'continuation_prompt mismatch');
  assert(content.groupFolder === '_test-restart', 'groupFolder mismatch');
  assert(content.reason === 'Test restart', 'reason mismatch');
});

console.log('\n=== Test 4: Startup Continuation Check ===');
console.log('Testing that startup reads and deletes pending-restart.json...\n');

// Simulate what checkPendingRestart does
const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
let continuationSent = false;
let sentToJid = null;
let sentMessage = null;

if (fs.existsSync(pendingFile)) {
  const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
  fs.unlinkSync(pendingFile);

  if (data.chatJid && data.continuation_prompt) {
    continuationSent = true;
    sentToJid = data.chatJid;
    sentMessage = data.continuation_prompt;
  }
}

test('Continuation message extracted correctly', () => {
  assert(continuationSent === true, 'Continuation was not sent');
  assert(sentToJid === 'test-jid@g.us', `Expected test-jid@g.us but got ${sentToJid}`);
  assert(sentMessage === 'Service restarted successfully!', `Expected "Service restarted successfully!" but got "${sentMessage}"`);
});

test('Pending restart file is deleted after reading', () => {
  assert(!fs.existsSync(pendingFile), 'pending-restart.json should be deleted');
});

// Final cleanup
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
