# restart_service 功能实现文档

## 概述

`restart_service` 是一个 MCP 工具，允许容器内的 agent 请求 NanoClaw 主进程重启，并在重启完成后发送续接消息继续对话。

**使用场景**：
- 应用配置更改（如添加新 group、修改 trigger）
- 更新依赖或代码后需要重启生效
- 需要清理状态或重新初始化连接

## 架构设计

### 数据流

```
Agent (container)
  ↓ 调用 restart_service 工具
MCP Server (ipc-mcp-stdio.ts)
  ↓ 写入 IPC task 文件
Host IPC Watcher (src/ipc.ts)
  ↓ 保存 continuation 到 pending-restart.json
  ↓ 发送 SIGTERM
Host Process 优雅退出
  ↓
Service Manager (launchd/systemd) 自动重启
  ↓
Host Process 启动 (src/index.ts)
  ↓ checkPendingRestart()
  ↓ 读取并删除 pending-restart.json
Channel (Telegram/WhatsApp)
  ↓ 发送 continuation_prompt
User 收到续接消息
```

### 关键组件

#### 1. Context 文件传递 (agent-runner)

**文件**: `container/agent-runner/src/index.ts`

在 SDK 启动前写入 context 文件：

```typescript
const contextFile = path.join(IPC_DIR, 'context.json');
fs.writeFileSync(contextFile, JSON.stringify({
  chatJid: containerInput.chatJid,
  groupFolder: containerInput.groupFolder,
  isMain: containerInput.isMain,
}));
```

**路径**: `/workspace/ipc/context.json` (容器内)
**映射**: `data/ipc/{groupFolder}/context.json` (宿主机)

#### 2. MCP Server Context 读取

**文件**: `container/agent-runner/src/ipc-mcp-stdio.ts`

使用 `getContext()` 懒加载 context：

```typescript
function getContext(): Context {
  if (_context) return _context;

  // 优先从 context 文件读取
  try {
    const data = JSON.parse(fs.readFileSync(path.join(IPC_DIR, 'context.json'), 'utf-8'));
    if (data.chatJid && data.groupFolder) {
      _context = { chatJid: data.chatJid, groupFolder: data.groupFolder, isMain: !!data.isMain };
      return _context;
    }
  } catch { /* fall through */ }

  // 降级到环境变量
  _context = {
    chatJid: process.env.NANOCLAW_CHAT_JID || '',
    groupFolder: process.env.NANOCLAW_GROUP_FOLDER || '',
    isMain: process.env.NANOCLAW_IS_MAIN === '1',
  };
  return _context;
}
```

**设计原因**：
- Context 文件比环境变量更可靠（不依赖 SDK 的 env 传递机制）
- 懒加载避免模块加载时读取失败
- 环境变量作为降级方案保持兼容性

#### 3. restart_service 工具

**文件**: `container/agent-runner/src/ipc-mcp-stdio.ts`

```typescript
server.tool(
  'restart_service',
  'Request the NanoClaw host process to restart. Use when applying configuration changes that require a service restart. Optionally provide a continuation_prompt that will be sent to the group after restart completes.',
  {
    reason: z.string().describe('Why the restart is needed'),
    continuation_prompt: z.string().optional().describe('Message to send to the group after the restart completes, so you can continue where you left off'),
  },
  async (args) => {
    const ctx = getContext();
    const data = {
      type: 'restart_service',
      reason: args.reason,
      continuation_prompt: args.continuation_prompt,
      chatJid: ctx.chatJid,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Restart requested: ${args.reason}. The service will restart shortly.${args.continuation_prompt ? ' A continuation message will be sent after restart.' : ''}` }],
    };
  },
);
```

**IPC 文件格式**：

```json
{
  "type": "restart_service",
  "reason": "Applied new group configuration",
  "continuation_prompt": "Configuration updated! The service has been restarted.",
  "chatJid": "tg:7166612891",
  "groupFolder": "main",
  "timestamp": "2026-03-03T02:30:00.000Z"
}
```

#### 4. Host IPC 处理

**文件**: `src/ipc.ts`

```typescript
case 'restart_service': {
  const registeredGroupsList = deps.registeredGroups();

  // 从 sourceGroup 反查 chatJid
  let restartChatJid: string | undefined;
  for (const [jid, group] of Object.entries(registeredGroupsList)) {
    if (group.folder === sourceGroup) {
      restartChatJid = jid;
      break;
    }
  }

  // 保存 continuation 数据
  if (data.continuation_prompt && restartChatJid) {
    const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
    fs.writeFileSync(pendingFile, JSON.stringify({
      chatJid: restartChatJid,
      groupFolder: sourceGroup,
      continuation_prompt: data.continuation_prompt,
      reason: data.reason,
      timestamp: new Date().toISOString(),
    }));
    logger.info({ sourceGroup, reason: data.reason }, 'Saved restart continuation data');
  }

  logger.info({ sourceGroup, reason: data.reason }, 'Restart requested via IPC, exiting for service manager to restart');

  // 延迟后发送 SIGTERM 触发优雅关闭
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 500);
  break;
}
```

**pending-restart.json 格式**：

```json
{
  "chatJid": "tg:7166612891",
  "groupFolder": "main",
  "continuation_prompt": "Configuration updated! The service has been restarted.",
  "reason": "Applied new group configuration",
  "timestamp": "2026-03-03T02:30:00.000Z"
}
```

**存储位置**: `data/pending-restart.json`

#### 5. 启动时 Continuation 检查

**文件**: `src/index.ts`

```typescript
async function checkPendingRestart(): Promise<void> {
  const pendingFile = path.join(DATA_DIR, 'pending-restart.json');
  if (!fs.existsSync(pendingFile)) return;

  try {
    const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
    // 立即删除防止重复发送
    fs.unlinkSync(pendingFile);

    if (data.chatJid && data.continuation_prompt) {
      const channel = findChannel(channels, data.chatJid);
      if (channel) {
        await channel.sendMessage(data.chatJid, data.continuation_prompt);
        logger.info({ chatJid: data.chatJid, groupFolder: data.groupFolder }, 'Sent restart continuation message');
      } else {
        logger.warn({ chatJid: data.chatJid }, 'No channel found for restart continuation message');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error processing pending restart');
    try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
  }
}
```

**调用时机**: `main()` 函数中，channels 连接后立即调用：

```typescript
// Create and connect channels
if (TELEGRAM_BOT_TOKEN) { ... }
if (!TELEGRAM_ONLY) { ... }

// Start subsystems
await checkPendingRestart();  // ← 在这里
startSchedulerLoop({ ... });
```

## 安全考虑

### 权限控制

当前实现：**所有 group 都可以触发重启**

**原因**：
- 任何 group 都可能需要应用配置更改
- IPC 文件基于目录隔离，已有基本的 namespace 保护
- 重启是优雅的（SIGTERM），不会丢失数据

**未来改进**：
- 可以在 `processTaskIpc` 中添加 `isMain` 检查，限制只有 main group 可以重启
- 或者添加 rate limiting 防止滥用

### 数据持久化

- `pending-restart.json` 存储在 `DATA_DIR`，重启后仍然存在
- 读取后立即删除，防止重复发送
- 如果发送失败，文件已被删除，不会重试（trade-off: 简单性 vs 可靠性）

## 测试

### 单元测试

**文件**: `scripts/test-restart-service.cjs`

测试覆盖：
1. Context 文件写入和读取
2. IPC task 文件格式
3. chatJid 从 sourceGroup 反查
4. pending-restart.json 生成
5. 启动时 continuation 读取和清理

运行：
```bash
node scripts/test-restart-service.cjs
```

### 容器测试

测试 MCP Server 在容器内读取 context 并调用 `restart_service`：

```bash
# 创建测试 IPC 目录
mkdir -p /tmp/nanoclaw-test-ipc/{messages,tasks,input}
echo '{"chatJid":"test@g.us","groupFolder":"test","isMain":false}' > /tmp/nanoclaw-test-ipc/context.json

# 通过 JSON-RPC 调用 restart_service
(sleep 2; printf '{"jsonrpc":"2.0","method":"initialize",...}\n'; ...) | \
docker run -i --rm --entrypoint bash \
  -v /tmp/nanoclaw-test-ipc:/workspace/ipc \
  nanoclaw-agent:latest \
  -c 'cd /app && npx tsc --outDir /tmp/dist && node /tmp/dist/ipc-mcp-stdio.js'

# 检查 IPC 文件
cat /tmp/nanoclaw-test-ipc/tasks/*.json
```

### 端到端测试

在运行的服务上测试完整流程：

```bash
# 写入 restart_service IPC 文件
cat > data/ipc/main/tasks/$(date +%s)-test.json << 'EOF'
{
  "type": "restart_service",
  "reason": "e2e test",
  "continuation_prompt": "Restart successful!",
  "chatJid": "tg:7166612891",
  "groupFolder": "main",
  "timestamp": "2026-03-03T02:30:00.000Z"
}
EOF

# 观察日志
tail -f logs/nanoclaw.log
```

**预期结果**：
1. `Saved restart continuation data`
2. `Restart requested via IPC, exiting for service manager to restart`
3. `Shutdown signal received` (SIGTERM)
4. 服务重启（新 PID）
5. `Sent restart continuation message`
6. Telegram 收到 "Restart successful!"

## 故障排查

### Context 读取失败

**症状**: MCP Server 工具调用时 `chatJid` 或 `groupFolder` 为空

**检查**：
1. 容器日志中是否有 "Wrote context file" 消息
2. 检查 `data/ipc/{groupFolder}/context.json` 是否存在
3. 检查容器 mount 配置是否正确

**解决**：
- 确保 agent-runner 在 SDK 启动前写入 context 文件
- 检查 `/workspace/ipc` mount 是否可写

### Continuation 消息未发送

**症状**: 重启后没有收到 continuation 消息

**检查**：
1. `data/pending-restart.json` 是否在重启前生成
2. 启动日志中是否有 "Sent restart continuation message"
3. 检查 `chatJid` 是否正确反查

**解决**：
- 确保 IPC 文件包含 `continuation_prompt` 字段
- 确保 `chatJid` 能从 `registeredGroups` 中找到对应的 group
- 检查 channel 是否已连接

### 重启循环

**症状**: 服务不断重启

**检查**：
1. `pending-restart.json` 是否在读取后被删除
2. 是否有多个 `restart_service` IPC 文件

**解决**：
- 确保 `checkPendingRestart()` 在读取后立即删除文件
- 清理 `data/ipc/*/tasks/` 中的旧 IPC 文件

## 未来改进

1. **权限控制**: 限制只有 main group 可以重启
2. **Rate Limiting**: 防止短时间内多次重启
3. **Retry 机制**: Continuation 消息发送失败时重试
4. **Graceful Degradation**: 如果 channel 未连接，延迟发送或记录到队列
5. **Audit Log**: 记录所有重启请求到专门的日志文件

## 相关文件

- `container/agent-runner/src/index.ts` - Context 文件写入
- `container/agent-runner/src/ipc-mcp-stdio.ts` - MCP Server 工具定义
- `src/ipc.ts` - Host IPC 处理
- `src/index.ts` - 启动时 continuation 检查
- `docs/DEBUG-restart-service-continuation.md` - 调试历史记录
- `scripts/test-restart-service.cjs` - 单元测试
