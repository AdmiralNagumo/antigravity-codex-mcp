# 由 Antigravity 理解需求并指挥 Codex

用户说“把登录弄方便一点”，不需要知道模型标识、会话编号、工具参数或测试命令。Antigravity 先结合当前项目理解问题，普通细节自己补全；如果“延长登录有效期”与“简化登录界面”会导致不同结果且上下文不足，再问一个具体问题。

## 派工示例

下面是 Antigravity 内部整理的调用，不是要求用户填写的表单。例子假定上下文已经明确用户希望保留登录状态；不能仅凭“方便一点”就擅自确认这个目标。

```json
{
  "cwd": "D:/your-project",
  "request_id": "login-session-1",
  "brief": {
    "kind": "implementation",
    "user_request": "关闭应用再打开不要每次都让我登录",
    "goal": "在有效登录期内重新打开应用可以继续使用",
    "context": "先检查项目现有的登录和凭据保存方式，沿用已有机制。",
    "scope": ["修复应用重启后的登录状态恢复"],
    "acceptance_criteria": [
      "有效登录状态在重启后恢复",
      "凭据失效时可以重新登录",
      "主动退出后不恢复旧登录"
    ],
    "constraints": ["保留主动退出能力", "不在日志中输出登录凭据"],
    "assumptions": ["沿用现有登录有效期，不新增自动延长有效期的行为"]
  }
}
```

把上述对象交给 `codex_delegate`。确认目录与任务授权范围后，桥接生成指令并保存 brief。`sandbox` 默认 `workspace-write`；分析任务可以选择 `read-only`。不主动弹出技术面板。

## 等待、纠偏与验收

- 保存返回的 `conversation_id`。使用 `codex_wait` 的 `compact: true` 监控，把 `next_cursor` 作为下一次 `after`。
- `coordination.next_action` 是协调提示，不能代替阅读错误和待处理请求。审批仍需依据用户授权；常规技术问题由 Antigravity 回答。
- `completed` 后调用 `codex_result`。长报告继续传 `offset: report.next_offset` 与同一 `report_id: report.report_id`，直到为 null。保留较早消息中的失败和限制，不能只读最后一句。
- 结果包包含原始 brief、本轮报告和“尚未独立验证”的标记。Antigravity 对照验收条件查看实际证据；不能把自述“测试通过”直接改写成自己已经验证。
- 只针对本次改动做必要检查。若有缺口，使用同一 `conversation_id` 调用 `codex_send`，说明差距和期望，不重发全部聊天。
- 用户改变要求时，在 `codex_send` 中传入完整更新的 `brief`，桥接保存新要求并传给 Codex；不要继续按过时的 brief 验收。普通纠偏只需发送增量指令，不必重复 brief。完全不同的任务另建会话。
- 运行中可用 `mode: steer` 补充要求；失败、断线或结果不确定时检查状态，不自动重放任务。
- 用 `codex_recover` 重新连接并读取准确原生 thread。未知或仍活跃的轮次不会自动重发。

通过 `codex_review` 为每个验收条件保存判断，绑定当前 `report_id`：`accepted`、`needs_changes` 或 `blocked`。每项填写零起始的 `criterion_index`、`met/not_met/unverified` 状态、具体依据和来源。`host_observed` 表示宿主声明的实际检查，`codex_event` 必须引用结果包中的 `evidence_id`，`codex_claim` 只表示自述，不能单独用于通过验收。

通过后的状态是 `ready_to_explain`，表示准备好向用户说明；没有宿主回执时，不记录为已经发送。新要求或新轮次使旧验收失效。连续两轮没有有效进展时，必须更新调查思路或说明阻碍，不能不断重发相同任务。桥接保存评估依据，但不假装能自动判断任意产品需求是否正确。

桥接不持续监视其他客户端的文件修改。相关代码或环境变化后，应重新核对受影响的证据，不能仅凭保存的通过状态交付。

## 向用户解释

先说实际效果，再说如何使用；只补充影响用户的重要限制。使用用户的语言，保留真实的不确定性。技术报告作为内部依据，用户想了解时再展开。

合适的回答（仅当证据支持时）：

> 现在关闭应用再打开时，会恢复仍然有效的登录状态。主动退出后仍需重新登录；登录过期时会提示你重新登录。你可以退出应用再打开试一下。

如果只检查了代码、没有运行真实账号登录，应补充：

> 登录恢复逻辑已经改好，相关检查通过；真实账号在应用重启后的表现还需要你在本机试一下。

不要把“已实现 token hydration，修改 auth.ts，通过 17 个用例”作为默认交付方式，也不要把失败包装成成功。

## 宿主支持与中断

原生 `codex-coordinator` Skill 是主要流程入口，安装器可同时配置 Skill 和 MCP。MCP 初始化 instructions、`codex://orchestration` 资源及 `codex_orchestrate` prompt 是补充；没有 prompt 菜单时仍可使用工具。

MCP 无法强迫宿主继续推理或在宿主停止后定时唤醒。若被中断，继续监控原会话即可。磁盘上的 brief、消息和当前轮次边界用于恢复，不是后台自动协调者。
