# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Customizations vs Upstream

This fork includes the following modifications from upstream NanoClaw:

### 1. Docker Runtime (db03420)
- **Changed**: Default container runtime from Apple Container to Docker
- **Files**: `src/container-runtime.ts`, `container/build.sh`
- **Reason**: Better debugging tools (docker exec, logs, inspect)
- **Revert**: Set `CONTAINER_RUNTIME_BIN = 'container'` and update build.sh

### 2. Telegram Support (464f5eb)
- **Added**: Full Telegram channel integration
- **Files**: `src/channels/telegram.ts`, `src/channels/telegram.test.ts`
- **Config**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY` env vars
- **Features**: Bot commands, message formatting, typing indicators
- **Revert**: Remove telegram files, remove from src/index.ts channel setup

### 3. restart_service Tool (7c8e8c1, e193154)
- **Added**: MCP tool for agents to request service restart with continuation
- **Files**:
  - `container/agent-runner/src/index.ts` - writes context.json
  - `container/agent-runner/src/ipc-mcp-stdio.ts` - getContext() + restart_service tool
  - `src/ipc.ts` - restart_service IPC handler
  - `src/index.ts` - checkPendingRestart() injects continuation as user message
- **Flow**: Agent calls restart_service → saves continuation → SIGTERM → restart → continuation injected as user message → agent responds
- **Docs**: `docs/restart-service-implementation.md`, `docs/DEBUG-restart-service-continuation.md`
- **Tests**: `scripts/test-restart-service.cjs`
- **Revert**: Remove restart_service tool, checkPendingRestart(), IPC handler

### 4. Testing Tools (db03420)
- **Added**: `scripts/test-message.cjs` - simulate user messages for e2e testing
- **Revert**: Delete scripts/test-message.cjs

### Summary of Changes
- **+2802 lines, -1460 lines** vs upstream/main
- **Core changes**: Docker runtime, Telegram channel, restart_service feature
- **New files**: 7 (telegram.ts, test scripts, docs)
- **Modified files**: 21 (container-runner, ipc, index, config, etc.)

To sync with upstream: `git fetch upstream && git rebase upstream/main` (may require conflict resolution for customizations)

---

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime

**当前使用: Docker**

NanoClaw使用Docker作为容器运行时。Docker提供了更好的调试工具：

```bash
# 查看运行中的容器
docker ps | grep nanoclaw

# 进入容器调试
docker exec -it <container-name> bash

# 查看容器日志
docker logs -f <container-name>

# 查看容器详细信息
docker inspect <container-name>
```

如需切换回Apple Container，修改 `src/container-runtime.ts` 中的 `CONTAINER_RUNTIME_BIN`。
