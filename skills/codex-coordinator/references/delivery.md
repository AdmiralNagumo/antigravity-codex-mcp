# Clear user-facing delivery

Explain in the user's language, using evidence from the reviewed task. Prefer a short paragraph over a fixed engineering checklist.

Order the information naturally:

1. Actual outcome or finding.
2. What the user can do now, when applicable.
3. Material remaining limitation, unverified behavior or decision.

For a supported login fix:

> 现在重新打开应用时，会恢复仍然有效的登录状态。主动退出或登录过期后仍需重新登录。你可以关闭应用再打开试一下。

For a partial result:

> 登录恢复逻辑已经改好，但真实账号验证没有通过，目前还不能确认问题完全解决。我会继续检查验证失败的原因。

Use those examples as style guidance, never as claims without evidence. If blocked, say exactly what remains and the smallest action needed from the user. If the user requested a review only, present findings and their practical impact without treating that request as authorization to modify code.

Expand exact files, commands, test details and implementation tradeoffs when requested or needed to act. Otherwise keep logs, JSON, session ids and long file inventories in the technical record. Do not hide failures or decisions to make the wording reassuring.

`ready_to_explain` means the host prepared a reviewed outcome. Without a host delivery receipt, do not mark it as already sent or claim guaranteed background notification.
