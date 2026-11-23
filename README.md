# Antigravity Codex MCP

在 Antigravity 里让模型指挥本机 Codex：提交任务、打开 Codex 对话、读取执行进度、多轮追问、运行中补充指令、停止任务、处理审批。

**Antigravity App** 使用原生 MCP Apps 侧栏；**Antigravity IDE** 可安装仓库自带的 VSIX 对话面板。界面与模型调用的 MCP 工具操作同一份会话状态。

这是一套基于 Codex 官方 `app-server` 的独立对话界面，不会嵌入或遥控 Codex 桌面窗口。Codex 的模型上下文与 Antigravity 分开，派工时应传入目标、范围、项目目录和验收标准。

## 环境要求

- Node.js 22 或更新版本；运行时零 npm 依赖。
- Codex CLI，能够运行 `codex app-server`，已完成 `codex login`。
- 原生界面需要支持 MCP Apps 的 Antigravity App（官方文档注明 v2.34.0+，且初始化时声明 `io.modelcontextprotocol/ui`）。IDE/CLI 仍可调用所有工具；IDE 界面需要下面的扩展。
- `app-server` 是实验性接口，建议固定已验证的 Codex 版本。不要依赖旧版 `codex mcp-server`。

## 安装到 Antigravity App

克隆到本机：

```powershell
git clone https://github.com/AdmiralNagumo/antigravity-codex-mcp.git
cd antigravity-codex-mcp
node bin/bridge.mjs --help
```

有两种配置方式，选择一种即可。

### 方式 A：直接添加自定义 MCP（最容易排查）

在 Antigravity 的 MCP 设置中打开原始配置，合并下列 `codex` 条目。替换三个路径：仓库、会话状态目录、允许操作的项目。

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": [
        "D:/tools/antigravity-codex-mcp/bin/bridge.mjs",
        "--state-dir", "D:/CodexBridgeState",
        "--allow-root", "D:/your-project"
      ],
      "cwd": "D:/your-project",
      "timeoutSeconds": 120
    }
  }
}
```

也可以用配置脚本。默认只打印合并后的配置；加 `--write` 才会写入，且先备份原文件，保留其他 MCP 条目：

```powershell
node scripts/install.mjs --project D:/your-project --config C:/path/to/mcp_config.json
node scripts/install.mjs --project D:/your-project --config C:/path/to/mcp_config.json --write
```

请使用 App 设置里显示的实际配置文件路径；不同版本的位置可能不同。脚本未指定 `--config` 时使用 `~/.gemini/config/mcp_config.json`。

### 方式 B：安装 Antigravity 插件

如果本机有 `agy` CLI：

```powershell
agy plugin validate . --strict
agy plugin install .
```

插件通过 `CODEX_PROJECT_ROOT` 设置允许操作的项目目录。含配置变量的插件安装后可能先处于禁用状态，在 Customizations 或 `/plugin` 中填入项目的绝对路径并启用。

刷新 MCP 连接后，在 Antigravity 里输入：

> 调用 codex_open 打开 Codex 对话面板。然后让 Codex 分析 D:/your-project 的代码结构。把目标和验收标准交给它，持续读取进度，完成后检查结果；需要修改时继续同一个会话。

`codex_open` 声明了 Antigravity 的 `aux_pane` / `global` 入口，在支持的 App 中打开侧栏或全页视图。面板可新建对话、查看消息与执行记录、继续发送任务、补充运行中指令、停止和处理审批。

## Antigravity IDE 对话面板（可选）

官方当前把原生 MCP Apps 界面限定在 App；IDE 不会渲染 `ui://`。本仓库提供一个不依赖 MCP Apps 的兼容扩展：

```powershell
npm run package:extension
```

在 IDE 的扩展菜单中选择 **Install from VSIX**，安装生成的 `dist/antigravity-codex-panel-0.1.0.vsix`。扩展只需读取前面启动的桥接服务，不启动另一个 Codex。

把扩展设置 `codexBridge.stateDir` 设成 MCP 的 `--state-dir`，然后执行 **Codex Bridge: Open Conversation**。默认在 `codex_open` 或新任务出现时自动打开。扩展需要可信工作区；认证令牌只在扩展宿主中使用，不会注入面板页面。

## MCP 工具

| 工具 | 功能 |
| --- | --- |
| `codex_open` | 打开对话面板，或切换指定 conversation_id |
| `codex_start` | 创建 Codex thread 并提交任务，立即返回 conversation_id |
| `codex_send` | `next` 继续下一轮；`steer` 向正在执行的轮次补充要求 |
| `codex_list` | 列出桥接服务管理的会话和允许的项目目录 |
| `codex_read` | 读取消息、增量事件、状态和待处理审批 |
| `codex_wait` | 等待最多 20 秒，返回新事件或终态 |
| `codex_resume` | 按真实 Codex thread_id 恢复会话 |
| `codex_cancel` | 请求停止当前轮次，已发生的文件修改保留 |
| `codex_respond` | 答复命令/文件审批或结构化问题 |
| `codex_models` | 查询当前 Codex 账号可用模型 |
| `codex_diagnose` | 检查桥接和 app-server 握手，不运行模型任务 |

`codex_start` / `codex_send` 要求 `request_id`。重试同一操作时，复用相同 ID 和相同参数，避免重复提交。服务在提交任务前保存操作意图，每个会话保留最近 100 条去重记录；这是一种保守的至多一次提交策略，不是跨进程的 exactly-once 保证。不要在超时后换新 ID 盲目重试。

典型模型调用流程：

1. `codex_start({cwd, prompt, request_id})`。
2. `codex_open({conversation_id})` 展示对话。
3. 重复 `codex_wait({conversation_id, after})`，使用返回的事件游标。
4. 遇到 `waiting_approval`，先检查 `pending_requests`，仅在用户授权范围内回复。
5. `completed` 后检查修改和测试结果；未满足目标就用同一个 conversation_id 调用 `codex_send`。

`running` / `starting` 不代表完成；`failed` / `disconnected` / `unknown` 也不代表成功。

## 会话与权限

- 使用已有的本地 Codex 登录与配置。不会把 Codex 凭据复制给 Antigravity，不需要把 API key 填进 MCP 配置。
- 同一状态目录的多个 MCP 客户端和面板共用一个后台服务。根目录、Codex 命令必须一致；配置变化先停止服务，或选用另一个状态目录。
- 项目必须位于显式允许的根目录内。真实路径会经过规范化检查，包括符号链接和路径边界。
- 默认 `workspace-write` 与 `on-request`，可选择 `read-only`；工具不开放 `danger-full-access`，审批不会自动接受。
- 同一个精确项目目录只允许一个活跃轮次。不同任务需要并行时请使用独立 worktree。父子项目或额外外部客户端仍可能互相影响，应避免同时写同一文件。
- 后台服务只监听 `127.0.0.1`，要求随机 Bearer 令牌，拒绝带 Origin 的浏览器请求，不启用 CORS。MCP Apps 通过宿主 `tools/call` 通信，IDE 面板通过扩展宿主通信。
- `runtime.json` 含本机连接令牌，`sessions.json` 含任务与消息，`daemon.log` 含诊断信息。这些都在 `--state-dir` 中，请放在仅当前用户可访问的位置；不要提交到 GitHub。类 Unix 平台使用 0700/0600；Windows 继承所在目录的 ACL。
- MCP 断开或面板关闭不会终止后台任务。服务重启后保存的消息仍可查看，下一次继续时尝试恢复 Codex thread；未完成轮次标为 disconnected，不自动重放。
- 恢复外部 thread 时不要与另一个控制客户端并发使用。桥接程序不接管既有 Codex 桌面窗口，也不提供多个控制者之间的全局互斥。
- 目前支持命令审批、文件审批与 requestUserInput；其他 app-server 反向请求明确返回不支持，不会静默挂起。外部导入会话优先读取当前版本提供的 thread 历史；新版分页历史的完整导入尚未实现。自己创建的会话由桥接持续保存消息。
- 面板消息和事件有长度/数量限制，长期完整历史以 Codex 自身存储为准。

## 诊断和停止

所有入口应使用同样的参数：

```powershell
node bin/bridge.mjs doctor --allow-root D:/your-project --state-dir D:/CodexBridgeState
node bin/bridge.mjs stop --allow-root D:/your-project --state-dir D:/CodexBridgeState
```

Codex 不在 PATH 时，加 `--codex C:/path/to/codex.exe`。Windows npm 安装的 `codex.cmd` 会解析到原生可执行文件或 Node 入口，参数不会拼接成 shell 命令。

## 测试

```powershell
npm run check
npm test
npm run package:extension
npm run smoke
```

`npm test` 使用独立 app-server 子进程 fixture 验证协议、流式消息、文件效果、多轮、幂等、审批、停止、目录限制和失败状态；这不等价于真实模型测试。HTTP 集成测试在宿主明确禁止回环连接时会标记 skipped，普通环境会实际验证 HTTP。

`npm run smoke` 使用真实 Codex 仅检查握手。执行真实模型的两轮文件编辑测试（会使用 Codex 配额）：

```powershell
node scripts/smoke.mjs --live-task
```

只验证协议、且当前执行环境不能写用户的 Codex 目录时，可用 `node scripts/smoke.mjs --isolated-home`。它使用空的临时 CODEX_HOME，不复制账号凭据，不能代替带登录状态的真实任务验收。

CI 在 Windows、Linux、macOS 上运行语法检查、fixture 测试并构建 VSIX。真正的 App 挂载效果和账号模型调用仍需在安装后的本机验证。

## 协议来源

- [Antigravity MCP](https://antigravity.google/docs/mcp)
- [Antigravity MCP Apps（界面能力和入口）](https://antigravity.google/docs/mcp-apps)
- [Antigravity 插件格式](https://antigravity.google/docs/build-plugins/)
- [MCP Apps 2026-01-26 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [Codex app-server](https://developers.openai.com/codex/app-server/)

本项目为独立集成，非 Google 或 OpenAI 官方产品。
