#!/usr/bin/env node
/**
 * 模拟用户发送消息到NanoClaw进行端到端测试
 * 用法: node scripts/test-message.js "消息内容" [group-folder]
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');

// 读取命令行参数
const messageContent = process.argv[2];
const targetGroupFolder = process.argv[3] || 'main';

if (!messageContent) {
  console.error('用法: node scripts/test-message.cjs "消息内容" [group-folder]');
  console.error('示例: node scripts/test-message.cjs "@Andy 测试重启功能" main');
  process.exit(1);
}

// 从数据库读取registered_groups
const db = sqlite3(DB_PATH);

let registeredGroups;
try {
  const rows = db.prepare('SELECT jid, name, folder FROM registered_groups').all();
  registeredGroups = {};
  for (const row of rows) {
    registeredGroups[row.jid] = {
      name: row.name,
      folder: row.folder
    };
  }
} catch (err) {
  console.error('无法读取registered_groups:', err.message);
  db.close();
  process.exit(1);
}

// 找到目标group的chatJid
const targetChatJid = Object.keys(registeredGroups).find(jid =>
  registeredGroups[jid].folder === targetGroupFolder
);

if (!targetChatJid) {
  console.error(`找不到group folder: ${targetGroupFolder}`);
  console.error('可用的groups:', Object.values(registeredGroups).map(g => g.folder).join(', '));
  db.close();
  process.exit(1);
}

const groupName = registeredGroups[targetChatJid].name;

// 插入测试消息到数据库

const msg = {
  id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  chat_jid: targetChatJid,
  sender: 'test-user',
  sender_name: 'Test User',
  content: messageContent,
  timestamp: new Date().toISOString()
};

try {
  db.prepare(`
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp);

  console.log('✓ 测试消息已插入');
  console.log(`  Group: ${groupName} (${targetGroupFolder})`);
  console.log(`  Chat JID: ${targetChatJid}`);
  console.log(`  Message ID: ${msg.id}`);
  console.log(`  Content: ${msg.content}`);
  console.log('');
  console.log('等待agent处理消息...');
  console.log('查看日志: tail -f logs/nanoclaw.log');
} catch (err) {
  console.error('插入消息失败:', err.message);
  process.exit(1);
} finally {
  db.close();
}
