---
name: dsh-waibao
description: Run parallel user-authorized DSH child tasks, exchange messages during execution, steer individual children and review their results in Codex.
---

# DSH 外包

Use this when the user authorizes a planner/executor split: Codex plans, reviews and accepts; DSH executes in its visible desktop session. This authorization is for this user's workflow, not unlimited delegation permission for every user.

## 分工

- Delegate a clear, self-contained implementation, investigation or test task proactively instead of asking again. Do low-cost one-step work yourself; do not start a model turn for every small edit.
- First round prompt: goal, scope, required decisions, exact file paths and acceptance. Follow up in the same task with only the delta and concrete findings; do not paste history or restate the task.
- Continue implementation, review fixes and verification in the same task and session. A long transcript or a model-selection error is not a reason to create a new session: reuse its context and cache, and resolve the specific error. Use a new task only for independent work or an explicit user request.
- DSH reports briefly: conclusion, files, verification, blockers. Detailed evidence stays in files.
- Split independent work into separate tasks and start them together with `spawn`; give each child clear file ownership and tell it other children may be editing the same workspace. Continue independent parent work while children run.
- Include this instruction in each child's prompt: call `send_to_parent({message})` for important findings, blockers or coordination requests as soon as they arise; continue authorized work that does not depend on a reply. Ordinary progress belongs in the desktop log. Final output still summarizes the result and evidence.
- On completion, Codex checks bounded actual output against the acceptance items. Do not repeat the full analysis or re-run tests that are still valid for the current state.

Installed package: `__PACKAGE_ROOT__`. Node: `__NODE__`. Both may contain spaces; use `&` with single-quoted paths exactly as shown below.

## 检查桌面

Run `& '__NODE__' '__PACKAGE_ROOT__/bin/cli.mjs' describe`. Verify the desktop is connected. Use DSH's current model selection unless the user specifies another route; any provider/model configured in DSH is valid. If disconnected, restore the DSH desktop instead of starting headless.

## 并行创建与查看

Write one absolute batch JSON:

```json
{
  "workspace": "D:\\code\\demo",
  "tasks": [
    {"task": "implementation", "prompt": "Implement X; own src/x.mjs. Report important findings with send_to_parent.", "acceptance": "X works"},
    {"task": "investigation", "prompt": "Investigate Y; read only. Report important findings with send_to_parent.", "acceptance": "Evidence with paths"}
  ]
}
```

```powershell
& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' spawn 'D:\code\demo\work\batch.json'
& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' list 'D:\code\demo'
```

`spawn` starts each task independently and returns `tasks` entries with `ok` plus the normal receipt or an explicit error. A failed item does not stop the others; any failed item makes the command exit nonzero. Inspect every item before deciding what to retry. `list` returns `agents` for the current parent chat and workspace, including task, job/session IDs, actual model selection, run state and message delivery errors. Separate tasks can run concurrently; an already active task rejects reentry.

## 提交一轮

Write one absolute spec JSON:

```json
{
  "workspace": "D:\\code\\demo",
  "task": "check-startup",
  "prompt": "Goal, scope, decisions and exact file paths for this round.",
  "acceptance": "What Codex will verify.",
  "title": "optional session title",
  "workspaceTitle": "optional workspace title"
}
```

Then run:

```powershell
& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' submit 'D:\code\demo\work\round-1.json'
```

- `workspace` is an existing absolute directory; `task` is a stable slug reused for continuation; `prompt` is this round's inline instructions; `acceptance` is what Codex verifies.
- Optional `selection: {provider, model, reasoningEffort}` applies to a new task or an idle continuation. Use the exact configured identifiers; the plugin has no model allowlist. Without it, new tasks use DSH's current default and continuations use that session's current selection, including desktop changes. A model change keeps the same task/session and context.
- submit derives the actual `CODEX_THREAD_ID`, Node, request/job IDs, binding, task/prompt/job specs and evidence paths. Do not write a second job JSON, a prompt file, a thread ID or an execution command.
- One compact JSON receipt is printed: `jobId`, `task`, `status`, `bindingPath`, `sessionId` and evidence paths. `status: "running"` means the desktop coordinator confirmed startup. A nonzero exit means submission or launch failed; read the error before acting.
- Paths live under `workspace/work/dsh-waibao/<thread>/<task>/`. The same thread and task reuse `binding.json`; other tasks and threads are isolated. Each round writes its own `rounds/<jobId>/` evidence and never overwrites an earlier round.
- An active round makes another submit for the same task fail. Wait for its completion callback or recorded exit, then submit the delta. Never change the binding's session ID to recover from a failure or disconnect. If startup is not confirmed, the task claim is kept for manual diagnosis; inspect the log and job record and do not resubmit automatically.
- After successful receipts, continue independent work or end the turn. React to child messages as they arrive; use `list` or `pending` for a concrete state question, without a polling loop, timer or heartbeat.

## 子代理给父任务发消息

The delegated child has a scoped `send_to_parent({message})` tool during its run. Important discoveries reach this originating Codex chat as `[DSH_WAIBAO_MESSAGE:<jobId>:<messageId>]` before completion. The message includes task/session identity; ordinary desktop sessions do not get this tool.

Read the finding, coordinate other children if needed, and reply to the specific running job with `append`. If that child is idle, continue with `submit` using the same task. Handle each message ID once. A child message conveys findings and requests; permission decisions still follow the approval flow below.

Delivery status is saved in `parentMessages` in the job record and `pending`/`read-run` summary; `list` reports delivery errors. A tool `sent` receipt confirms writing to the coordinator channel. `notifiedAt` records parent notification; `notificationError` means delivery was uncertain or failed. Inspect the saved message when needed; do not automatically resend tasks or messages.

## 工具审批

A delegated tool call may pause on an approval. The waiting round stays running and is not a completion. The coordinator prints one `[DSH_WAIBAO_APPROVAL:<jobId>:<approvalId>]` notification to this chat; process each approval once and do not wait with timers.

1. Tell the user which tool, call, reason and session are waiting. Never approve on your own, never switch the session to `never` or a global allow rule, and never fabricate an audit decision.
2. Inspect both approvals and ordinary questions with `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' pending JOB_ID`. It returns `runState`, separate `approvals`, `questions` and `appends`, and each approval carries `approvalId`, `sessionId`, `requestId`, `toolName` and `reason`. Only the originating Codex thread can list or decide.
3. After the user explicitly chooses, write `{"approvalId": "...", "outcome": "allowed-once" | "rejected"}` and run `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' answer JOB_ID 'ABSOLUTE_SPEC_JSON'`. The original request resumes in the same session. Repeating the same decision is idempotent; a conflicting decision is refused. A cancelled, expired or unknown approval is refused.
4. If the notification delivery was uncertain or no message arrived, use `pending` rather than resending the task or creating a new session. Leave an unresolved approval waiting.

The native `approval/request` waterfall allows one answerer per request. Delegated sessions are answered only through this Codex entry; non-delegated and ordinary desktop sessions keep their existing desktop approval UI.

## 普通问题与执行中追加

- A paused `ask_user_question` is an ordinary execution question, not a permission. The coordinator prints one `[DSH_WAIBAO_QUESTION:<jobId>:<questionId>]` notification with the complete questions and options. Under the user's existing authorization you may answer ordinary execution questions; real permissions, external side effects, and personal choices still need the user's explicit decision. Never treat a question as approval.
- Inspect both kinds with `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' pending JOB_ID`; it returns `runState` (`running`, `waiting`, `cancelled`, `completed`, `failed`, `ended`), separate `questions`, `approvals` and `appends` (`accepted`, `consumed`, `discarded`).
- Answer a question with an absolute spec `{"questionId": "...", "outcome": "answered", "answers": [{"id": "q1", "selected": ["Option A"], "custom": "optional"}]}` and `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' answer JOB_ID 'ABSOLUTE_SPEC_JSON'`. Use `"rejected"` to decline or `"cancelled"` to withdraw; every question of the call must be named exactly once when answered. For a real approval use `{"approvalId": "...", "outcome": "allowed-once" | "rejected"}`.
- Send a running-turn delta with an absolute spec `{"prompt": "...", "requestId": "optional stable id"}` and `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' append JOB_ID 'ABSOLUTE_SPEC_JSON'`. It uses the native steer mode on the exact current session and run. A repeated `requestId` is a no-op (`duplicate`), and the result distinguishes accepted (queued) from consumed. If the run is idle, use `submit` with the same task instead of `append`.
- Stop a delegated run with `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' stop JOB_ID`. This uses the native cancel and queue removal for the exact session/run, withdraws pending approvals/questions, and discards only this delegation's unconsumed deltas; unrelated desktop queue items and files/history stay. The one completion callback reports `cancelled`; afterwards continue the same task with `submit`.
- Process the notification once, keep no timer or polling loop, and use `pending` when delivery is uncertain.

## 完成与验收

The coordinator sends one completion callback to the originating chat. On `[DSH_WAIBAO_COMPLETION:...]`:

1. Read the bounded result and evidence paths: `& '__NODE__' '__PACKAGE_ROOT__/bin/read-run.mjs' JOB_ID`.
2. Check the stated acceptance items against actual files and the necessary tests. A callback is completion evidence, not acceptance.
3. Process each job once. `& '__NODE__' '__PACKAGE_ROOT__/bin/job.mjs' deliver JOB_ID` only reconciles an uncertain callback against recent history and refuses blind resend.

Usage reporting: unknown fields stay null; cache reads, uncached input and output are separate. Do not claim measured cost savings or add a price table.

## 边界

The desktop connection record is private; do not print its token or include it in evidence. A disconnect before `done` is uncertain: inspect the saved session before retrying because the model may still be running.
