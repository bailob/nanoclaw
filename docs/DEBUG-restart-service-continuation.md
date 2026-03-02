# restart_service continuation_prompt 功能调试记录

**日期**: 2026-03-02
**状态**: 未解决
**优先级**: 中

## 问题描述

`restart_service` MCP工具的 `continuation_prompt` 参数无法正常工作。当agent调用此工具并提供continuation_prompt时，重启后不会自动发送continuation消息给用户。

### 预期行为

1. Agent调用 `restart_service(reason="...", continuation_prompt="...")`
2. MCP Server将IPC数据写入 `/workspace/ipc/tasks/*.json`，包含：
   - `type: 'restart_service'`
   - `reason: string`
   - `continuation_prompt: string`
   - `chatJid: string` (从context获取)
   - `groupFolder: string` (从context获取)
3. Host进程读取IPC文件，保存continuation状态到 `groups/{groupFolder}/pending-restart.json`
4. Host进程重启
5. 重启后，host读取pending-restart.json，自动发送continuation消息给用户

### 实际行为

1. Agent成功调用restart_service
2. MCP Server写入IPC文件，但 `chatJid` 和 `groupFolder` 字段为 `undefined`
3. Host进程读取IPC文件，发现缺少必需字段，跳过保存continuation状态
4. 重启后没有continuation消息

### 错误日志

```
[19:39:49.368] INFO: Restart data received
  continuation_prompt: "🎉 成功！restart_service功能完全正常！"
[19:39:49.368] WARN: Skipping continuation save - missing required fields
  hasContinuationPrompt: true
  hasChatJid: false
  hasGroupFolder: false
```

## 根本原因

MCP Server无法获取运行时的context信息（`chatJid` 和 `groupFolder`）。

### 架构说明

```
Host Process (src/index.ts)
  └─> runContainerAgent(group, containerInput)
      └─> Container (agent-runner)
          ├─> containerInput via stdin (包含 chatJid, groupFolder, isMain)
          └─> Claude Agent SDK
              └─> MCP Server (ipc-mcp-stdio.ts) - 独立子进程
```

**关键问题**: MCP Server是SDK启动的独立子进程，需要通过某种方式接收context信息。

## 已尝试的解决方案

### 方案1: 环境变量传递 ❌

**实现**:
```typescript
// agent-runner/src/index.ts
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
}

// ipc-mcp-stdio.ts
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
```

**结果**: 失败。MCP Server接收到的环境变量为undefined。

**可能原因**: Claude Agent SDK可能没有正确传递env配置到子进程，或者有其他机制覆盖了环境变量。

### 方案2: 命令行参数传递 ❌

**实现**:
```typescript
// agent-runner/src/index.ts
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [
      mcpServerPath,
      containerInput.chatJid,
      containerInput.groupFolder,
      containerInput.isMain ? '1' : '0'
    ],
  },
}

// ipc-mcp-stdio.ts
if (process.argv.length >= 5) {
  chatJid = process.argv[2];
  groupFolder = process.argv[3];
  isMain = process.argv[4] === '1';
}
```

**结果**: 失败。MCP Server仍然无法获取到参数。

**可能原因**: SDK可能修改了args数组，或者MCP Server启动时机不对。

### 方案3: 临时文件传递 ❌

**实现**:
```typescript
// agent-runner/src/index.ts
const contextFile = '/tmp/nanoclaw-context.json';
fs.writeFileSync(contextFile, JSON.stringify({
  chatJid: containerInput.chatJid,
  groupFolder: containerInput.groupFolder,
  isMain: containerInput.isMain,
}));

// ipc-mcp-stdio.ts
const contextData = fs.readFileSync('/tmp/nanoclaw-context.json', 'utf-8');
const context = JSON.parse(contextData);
```

**结果**: 失败（未完全测试）。

**可能原因**: MCP Server可能在文件写入之前就启动了，或者在不同的文件系统命名空间。

### 方案4: IPC目录文件传递 (未完成)

**思路**: 将context写入 `/workspace/ipc/context.json`，MCP Server每次调用工具时读取。

**状态**: 实现到一半，遇到TypeScript编译错误，需要重构所有工具函数。

## 调试过程中的发现

### 1. 容器代码更新机制

- 容器镜像包含agent-runner源代码
- 运行时mount `data/sessions/{group}/agent-runner-src/` 到 `/app/src`
- 容器启动时通过entrypoint.sh重新编译 `/app/src` 到 `/tmp/dist`
- 修改源代码后需要：
  1. 更新 `container/agent-runner/src/`
  2. 重新构建容器镜像：`./container/build.sh`
  3. 或者更新 `data/sessions/{group}/agent-runner-src/` 目录

### 2. 测试工具

创建了 `scripts/test-message.cjs` 用于端到端测试：
```bash
node scripts/test-message.cjs "@Andy 测试消息" main
```

### 3. 日志查看

- 主进程日志: `logs/nanoclaw.log`
- 容器日志: `groups/{group}/logs/container-*.log` (仅verbose模式)
- MCP Server的stderr输出不容易查看

### 4. Apple Container vs Docker

当前使用Apple Container，调试工具有限：
- 无法轻松进入运行中的容器
- 日志查看不如Docker方便
- 但这不是问题的根本原因

## 当前困惑

### 1. Claude Agent SDK的MCP Server启动机制

**疑问**:
- SDK如何启动MCP Server子进程？
- `mcpServers.env` 配置是否真的会传递到子进程？
- `mcpServers.args` 是否会被SDK修改？
- 是否有其他配置方式可以传递context？

**需要**:
- 查看Claude Agent SDK源码
- 查看SDK文档关于MCP Server配置的部分
- 或者咨询Anthropic团队

### 2. MCP Server的生命周期

**疑问**:
- MCP Server何时启动？是在SDK初始化时还是首次调用工具时？
- 模块顶层代码（读取环境变量/参数）何时执行？
- 是否可以延迟读取context（在工具调用时）？

### 3. 为什么环境变量传递失败？

**疑问**:
- SDK是否使用了特殊的进程启动方式？
- 是否有环境变量白名单机制？
- 容器环境是否影响了环境变量传递？

## 可能的解决方向

### 方向1: 完成IPC文件方案 ⭐

将context写入 `/workspace/ipc/context.json`，MCP Server在每个工具函数中读取。

**优点**:
- 不依赖SDK的参数/环境变量传递机制
- `/workspace/ipc` 是已经mount的目录，文件访问可靠

**缺点**:
- 需要重构所有工具函数，添加 `getContext()` 调用
- 代码改动较大

**实现步骤**:
1. 在agent-runner/index.ts中写入context文件
2. 在ipc-mcp-stdio.ts中实现 `getContext()` 函数
3. 修改所有工具函数，使用 `getContext()` 获取context
4. 测试验证

### 方向2: 研究SDK源码

查看 `@anthropic-ai/claude-agent-sdk` 源码，了解：
- MCP Server启动的具体实现
- 环境变量和参数的传递机制
- 是否有其他配置选项

### 方向3: 简化方案

不使用continuation_prompt，改为：
- 重启后agent主动检查是否有未完成任务
- 或者用户手动触发后续任务
- 或者使用scheduled_task机制

### 方向4: 切换到Docker

虽然不能解决根本问题，但可以：
- 更方便地进入容器调试
- 查看MCP Server的实际启动命令和环境
- 使用 `docker exec` 测试各种方案

## 下一步建议

### 短期（如果需要快速解决）

1. 暂时禁用continuation_prompt功能
2. 在CLAUDE.md中说明restart后需要手动触发后续任务
3. 或者使用scheduled_task作为替代方案

### 中期（如果要彻底解决）

1. 完成方向1的IPC文件方案实现
2. 或者研究SDK源码找到正确的配置方式
3. 考虑切换到Docker以便更好地调试

### 长期（架构改进）

1. 考虑将MCP Server改为HTTP服务而非stdio
2. 或者使用其他IPC机制（如Unix socket）
3. 向Anthropic提issue或PR改进SDK的context传递机制

## 相关文件

- `container/agent-runner/src/index.ts` - Agent runner主逻辑
- `container/agent-runner/src/ipc-mcp-stdio.ts` - MCP Server实现
- `src/ipc.ts` - IPC处理逻辑（host端）
- `src/index.ts` - 重启后的continuation检查逻辑
- `scripts/test-message.cjs` - 测试工具

## 测试命令

```bash
# 发送测试消息
node scripts/test-message.cjs "@Andy 测试restart_service，reason='test', continuation_prompt='继续任务'" main

# 查看日志
tail -f logs/nanoclaw.log

# 检查IPC文件（需要快速执行）
find data/ipc -name "*.json" -mmin -1 | xargs cat

# 检查pending-restart文件
cat groups/main/pending-restart.json
```

## 参考资料

- Claude Agent SDK文档: https://github.com/anthropics/anthropic-sdk-typescript
- MCP协议规范: https://modelcontextprotocol.io/
- NanoClaw架构文档: docs/REQUIREMENTS.md
