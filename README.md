# Antigravity Codex MCP

你向 Antigravity 说需求，它负责理解和补全边界，指挥本机 Codex 实现，核对结果，再用你能理解的文字告诉你完成了什么、如何使用、还有什么限制。

**日常只需要与 Antigravity 对话。** Codex 的技术对话面板是可选的：App 可使用原生 MCP Apps 侧栏，IDE 可安装仓库自带的 VSIX。界面与模型调用的工具操作同一份会话状态。

底层通过 Codex 官方 `app-server` 调用本机 Codex，不遥控桌面窗口。Codex 看不到 Antigravity 当前聊天，因此由 Antigravity 自动整理上下文、目标、范围和验收条件；用户无需填写工程任务书。

## 日常工作方式（0.3.0）

配置完成后，可以直接说：

> 以后由你理解我的需求并指挥 Codex 完成；普通细节你自行补全，重要歧义再问我。完成后告诉我改好了什么、怎么用，不要直接转发工程报告。现在先帮我解决……

推荐运行下面的安装脚本，一次配置 MCP 与原生 `codex-coordinator` Skill。Skill 负责理解需求、按任务类型派工、核对证据和解释结果；底层 MCP 负责会话、审批、结果与恢复。MCP 初始化说明、`codex_orchestrate` prompt 和 `codex://orchestration` 资源作为补充入口。

Antigravity 的工作顺序：

1. 结合项目和对话理解需求，把原始意图、目标、范围、验收条件与必要假设整理为 brief。普通且可逆的细节自行决定；涉及重要结果或超出授权时才询问用户。
2. 用 `codex_delegate` 把 brief 交给 Codex。桥接保存 brief，生成执行指令，立即返回会话标识。此入口不会主动弹出技术面板。
3. 用 `codex_wait({conversation_id, after, compact: true})` 读取轻量状态并处理授权范围内的请求。必要时在同一会话补充指令。
4. 轮次结束后用 `codex_result` 取回 brief、本轮全部助手消息与观测到的命令/文件事件，核对实际结果并用 `codex_review` 保存逐项验收。尚未满足目标时，用同一会话继续纠偏。
5. 向用户解释实际效果、使用方法与重要限制。工程细节按需展开，不原样粘贴日志、JSON 或 Codex 自述。

`completed` 只表示一轮执行结束，验收状态初始为 `not_assessed`。Anti 对照证据记录 `accepted` / `needs_changes` / `blocked`；记录是宿主声明的评估，不是桥接自动证明产品正确。通过验收后为 `ready_to_explain`，不冒充已经向用户送达。新的轮次或要求变更会使旧验收失效。连续两轮没有进展时必须重新调查或报告阻碍。

长报告保留本轮全部助手消息，避免短的最终回答掩盖较早的失败。分页需同时传 `offset: report.next_offset` 与同一 `report_id: report.report_id`，跨轮次或内容改变时拒绝拼接。桥接不额外调用模型生成摘要。

这套规则指导宿主模型工作，但 MCP 无法强制已经结束的宿主轮次自动醒来，也不能代替模型理解需求或核实结果。若宿主中断，继续原会话的监控，不重复新建任务。完整使用示例见 [协调流程](docs/orchestration.md)。

## 环境要求

- Node.js 22 或更新版本；运行时零 npm 依赖。
- Codex CLI，能够运行 `codex app-server`，已完成 `codex login`。
- 原生界面需要支持 MCP Apps 的 Antigravity App（官方文档注明 v2.34.0+，且初始化时声明 `io.modelcontextprotocol/ui`）。IDE/CLI 仍可调用所有工具；IDE 界面需要下面的扩展。
- `app-server` 是实验性接口，建议固定已验证的 Codex 版本。不要依赖旧版 `codex mcp-server`。

## 从旧版升级

更新仓库代码，保留原有 MCP 配置与 `--state-dir` 会话目录。停止旧后台，运行安装脚本补上原生 Skill，再刷新 Antigravity 的 Skill 与 MCP 连接：

```powershell
node D:/mcp/bin/bridge.mjs stop --state-dir D:/CodexBridgeState
node D:/mcp/scripts/install.mjs --project D:/your-project --config C:/path/to/mcp_config.json --write
```

上面的路径来自示例，使用你实际配置的目录。不能只刷新 MCP 连接而让旧后台继续运行；新版会提示版本不一致，避免新入口落到不支持它的旧进程。

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

推荐用配置脚本同时安装协调 Skill。默认仅预览；加 `--write` 才会写入。保留其他 MCP 条目，以及现有 Codex 可执行文件、状态目录、允许根目录、超时和服务器设置；显式传入参数时使用新值：

```powershell
node scripts/install.mjs --project D:/your-project --config C:/path/to/mcp_config.json
node scripts/install.mjs --project D:/your-project --config C:/path/to/mcp_config.json --write
```

请使用 App 设置里显示的实际配置文件路径；不同版本的位置可能不同。脚本未指定 `--config` 时使用 `~/.gemini/config/mcp_config.json`。

默认 Skill 目录为 `~/.gemini/config/skills/codex-coordinator`。只对当前项目安装可加 `--scope project`，使用 `<project>/.agents/skills/codex-coordinator`。宿主使用其他目录时，用 `--skill-dir` 指定实际目录。安装后确认 Antigravity 能发现 `codex-coordinator`；目录存在不等于宿主已经加载。

安装器只升级自己管理的 Skill，同名的非托管 Skill 会被保留并报出冲突。配置备份保留在原文件旁；旧 Skill 备份放在状态目录的 `installer-backups` 中，避免被当作第二份活动 Skill 加载。升级不改动 Codex 登录或 `config.toml`。

### 方式 B：安装 Antigravity 插件

如果本机有 `agy` CLI：

```powershell
agy plugin validate . --strict
agy plugin install .
```

插件通过 `CODEX_PROJECT_ROOT` 设置允许操作的项目目录。含配置变量的插件安装后可能先处于禁用状态，在 Customizations 或 `/plugin` 中填入项目的绝对路径并启用。

刷新 MCP 连接后，在 Antigravity 里输入：

> 帮我理解 D:/your-project 的代码结构。由你整理问题并交给 Codex 分析，检查结论后用容易理解的中文向我说明。

`codex_open` 声明了 Antigravity 的 `aux_pane` / `global` 入口，在支持的 App 中打开侧栏或全页视图。面板可新建对话、查看消息与执行记录、继续发送任务、补充运行中指令、停止和处理审批。

## Antigravity IDE 对话面板（可选）

官方当前把原生 MCP Apps 界面限定在 App；IDE 不会渲染 `ui://`。本仓库提供一个不依赖 MCP Apps 的兼容扩展：

```powershell
npm run package:extension
```

在 IDE 的扩展菜单中选择 **Install from VSIX**，安装生成的 `dist/antigravity-codex-panel-0.3.0.vsix`。扩展只需读取前面启动的桥接服务，不启动另一个 Codex。

把扩展设置 `codexBridge.stateDir` 设成 MCP 的 `--state-dir`，然后执行 **Codex Bridge: Open Conversation**。默认在 `codex_open` 或新任务出现时自动打开。扩展需要可信工作区；认证令牌只在扩展宿主中使用，不会注入面板页面。

## MCP 工具

| 工具 | 功能 |
| --- | --- |
| `codex_open` | 打开对话面板，或切换指定 conversation_id |
| `codex_delegate` | 推荐派工入口；Anti 自动整理 brief，保存原始意图、范围与验收条件，再交给 Codex |
| `codex_start` | 创建 Codex thread 并提交任务，立即返回 conversation_id |
| `codex_send` | `next` 继续下一轮；`steer` 向正在执行的轮次补充要求 |
| `codex_list` | 列出桥接服务管理的会话和允许的项目目录 |
| `codex_history` | 自动发现本机 Codex 历史会话，支持标题搜索、项目筛选、分页和归档列表 |
| `codex_history_read` | 直接读取历史对话，无需手选或恢复会话；长消息可连续分页 |
| `codex_read` | 读取消息、增量事件、状态和待处理审批 |
| `codex_wait` | 等待最多 20 秒，返回新事件或终态 |
| `codex_result` | 返回保存的 brief 与本轮报告，供 Anti 核对并转成易懂说明；支持长报告分页 |
| `codex_review` | 保存绑定当前结果和要求版本的逐项验收、证据来源、使用方式与限制 |
| `codex_recover` | 重新连接并检查准确原生会话，不重放任务；未确定的执行保留为 unknown |
| `codex_resume` | 按真实 Codex thread_id 恢复会话 |
| `codex_cancel` | 请求停止当前轮次，已发生的文件修改保留 |
| `codex_respond` | 答复命令/文件审批或结构化问题 |
| `codex_models` | 查询当前 Codex 账号可用模型 |
| `codex_diagnose` | 检查桥接和 app-server 握手，不运行模型任务 |


## 自动查看已有 Codex 对话

在 Antigravity 中可以直接说：

> 列出我本机 Codex 中的所有对话，包含归档，按最近修改时间整理。

或者：

> 找到之前关于多模型路由的 Codex 对话，读取内容并总结进度，不要启动新任务。

模型会自行调用 `codex_history` 发现 thread_id，再用 `codex_history_read` 读取，无需你手动选会话或复制 ID。`query` 按标题子串搜索；需要按正文查找时，先分页列举，再读取候选会话。

- 列表覆盖运行桥接的本机 Codex 数据目录（CODEX_HOME），跨项目、跨 provider，并包含子代理会话。其他电脑、其他 CODEX_HOME 或尚未出现在该目录的会话不在此范围内。
- `codex_history` 默认列出未归档记录；另传 `archived: true` 列出归档记录。两者都应沿 `next_cursor` 翻页，直到返回 null。
- `codex_history_read` 返回用户和助手消息；沿 `next_cursor` 可继续读取后续消息，以及上一页未读完的长消息。不会恢复 thread、启动任务或导入桥接会话。
- 历史可跨所有本地项目读取。`can_resume` 仅表示项目目录是否位于允许范围内且仍存在，不表示其他客户端已释放控制权。继续任务时仍须确认外部客户端没有同时执行，再使用 `codex_resume`。
- `codex_list` 仍是桥接管理的会话列表；查询原生历史应使用 `codex_history`。

修改桥接代码后，需要先停止旧后台服务，再刷新 Antigravity 的 MCP 连接，才能加载新工具。停止命令应使用配置中的实际项目和 state-dir：

```powershell
node D:/mcp/bin/bridge.mjs stop --allow-root D:/your-project --state-dir D:/CodexBridgeState
```

`codex_delegate` / `codex_start` / `codex_send` / `codex_review` 要求 `request_id`。重试同一操作时，复用相同 ID 和相同参数，避免重复提交。服务在提交任务前保存操作意图，每个会话保留最近 100 条去重记录；这是一种保守的至多一次提交策略，不是跨进程的 exactly-once 保证。不要在超时后换新 ID 盲目重试。

典型模型调用流程：

1. Anti 整理 brief，调用 `codex_delegate({cwd, brief, request_id})`。已有直接 prompt 调用仍可使用 `codex_start`。
2. 用户需要查看技术对话时才调用 `codex_open({conversation_id})`；原始 `codex_start` 保留自动打开面板的行为。
3. 重复 `codex_wait({conversation_id, after, compact: true})`，把返回的 `next_cursor` 传给下一次 `after`。compact 不返回历史消息和执行日志；需要详情时用完整 `codex_read`。
4. 遇到 `waiting_approval`，先检查 `pending_requests`，仅在用户授权范围内回复。
5. `completed` 后完整读取 `codex_result`，检查修改与适当的验证结果，通过 `codex_review` 保存逐项依据；未满足目标就用同一个 conversation_id 调用 `codex_send`。核对完成后由 Anti 向用户解释。

`brief.kind` 可为 `implementation` / `bugfix` / `research` / `review`。后两者强制只读。调研转为已授权实现时，用 `codex_send` 传更新后的实现 brief 与 `sandbox: workspace-write`；运行中不能通过 steer 修改权限。

派工和下一轮可以传 `reasoning_effort`，只接受当前模型目录实际公布的值，不固定枚举或静默降级。不指定时沿用本机配置；`codex_models` 返回当前目录。

`running` / `starting` 不代表完成；`failed` / `disconnected` / `unknown` 也不代表成功。

## 会话与权限

- 使用已有的本地 Codex 登录与配置。不会把 Codex 凭据复制给 Antigravity，不需要把 API key 填进 MCP 配置。
- 同一状态目录的多个 MCP 客户端和面板共用一个后台服务。根目录、Codex 命令必须一致；配置变化先停止服务，或选用另一个状态目录。
- 项目必须位于显式允许的根目录内。真实路径会经过规范化检查，包括符号链接和路径边界。
- 默认 `workspace-write` 与 `on-request`，可选择 `read-only`；工具不开放 `danger-full-access`，审批不会自动接受。
- 同一个精确项目目录只允许一个活跃轮次。不同任务需要并行时请使用独立 worktree。父子项目或额外外部客户端仍可能互相影响，应避免同时写同一文件。
- 后台服务只监听 `127.0.0.1`，要求随机 Bearer 令牌，拒绝带 Origin 的浏览器请求，不启用 CORS。MCP Apps 通过宿主 `tools/call` 通信，IDE 面板通过扩展宿主通信。
- `runtime.json` 含本机连接令牌，`sessions.json` 含任务与消息，`daemon.log` 含诊断信息。这些都在 `--state-dir` 中，请放在仅当前用户可访问的位置；不要提交到 GitHub。类 Unix 平台使用 0700/0600；Windows 继承所在目录的 ACL。
- MCP 断开或面板关闭不会终止后台任务。Codex 子进程退出后，后续连接可重新建立；用 `codex_recover` 检查准确原生 thread。只有可对应的终态才能恢复为 completed / failed / cancelled；仍活跃、历史不匹配或提交结果不确定时保留 unknown，不自动重放。
- 恢复外部 thread 时不要与另一个控制客户端并发使用。桥接程序不接管既有 Codex 桌面窗口，也不提供多个控制者之间的全局互斥。
- 目前支持命令审批、文件审批和 requestUserInput；其他 app-server 反向请求会明确返回不支持，不会静默批准。原生历史会话可通过 codex_history 自动发现，并通过 codex_history_read 分页读取；桥接程序另外保存自身管理会话的消息。
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
