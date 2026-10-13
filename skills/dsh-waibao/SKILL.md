---
name: dsh-waibao
description: Delegate user-authorized work from Codex to a visible DSH desktop session, continue its context and receive a completion callback.
---

# DSH 外包

Use only for work the user has authorized you to delegate. Explain that DSH executes the task in its visible desktop session and returns completion to this Codex chat. Review its actual outputs and appropriate tests before claiming success.

Installed package: `__PACKAGE_ROOT__`. Node: `__NODE__`.

1. Run Node with `__PACKAGE_ROOT__/bin/cli.mjs describe`. Verify the serving desktop and provider/model. Preserve the agreed billing route. If disconnected, restore DSH desktop; do not start headless as an automatic substitute.
2. Write a task-local JSON with absolute `workspace`, `bindingPath`, `promptFile`, a unique `requestId`, and optional `workspaceTitle` and `title`. Put the binding and evidence under the task workspace. For a new session only, optional `selection` may specify `{provider, model, reasoningEffort}`. Omission uses the verified desktop default.
3. Reuse the exact binding for follow-ups. Only append the new request and concrete findings; do not paste the previous transcript. Wait for the previous turn to finish. Never change the binding's session ID to recover an error.
4. Write a separate callback job JSON: unique `id`; actual `threadId` from `CODEX_THREAD_ID`; same `workspace`; `command: {executable: "__NODE__", args: ["__PACKAGE_ROOT__/bin/cli.mjs", "run", "ABSOLUTE_TASK_JSON"]}`; new absolute `stdoutPath`, `stderrPath`, `exitPath` under the workspace; `reviewPrompt` with acceptance requirements and binding path. No keys in either specification.
5. Start Node `__PACKAGE_ROOT__/bin/job.mjs run ABSOLUTE_JOB_JSON` in the Codex desktop environment. On Windows use `Start-Process -WindowStyle Hidden` for detached execution and quote paths correctly. Call `status JOB_ID` once to confirm startup. Then work independently or end the turn. The coordinator sends one completion callback to the originating chat. Do not add polling, timers or a heartbeat.
6. On `[DSH_WAIBAO_COMPLETION:...]`, inspect the exit record and run Node `__PACKAGE_ROOT__/bin/read-run.mjs ABSOLUTE_STDOUT_JSONL` for bounded results. Verify session identity, actual artifacts and necessary tests. A callback is completion evidence, not acceptance. Process each job once.

The desktop connection record is private. Do not print its token or include it in evidence. A disconnect before `done` is uncertain: inspect the saved session before retrying, because the model may still be running. `job.mjs deliver JOB_ID` reconciles a previous uncertain callback against recent history and refuses blind resend.

To adopt an old headless session: first confirm its old process ended, then `cli.mjs adopt ABSOLUTE_JSON` with the exact original `workspace`, recovered `sessionId` and optional `workspaceTitle`. Verify sidebar and transcript. The first desktop run specifies that session ID; later rounds reuse the binding. Adoption alone never runs a prompt.

Desktop visibility and model caching are separate. Report actual provider/model and observed usage. Cache reads, uncached input and output are distinct; do not infer cache hit rate or money saved from cost. Missing usage fields remain unknown. Context compaction and billing behavior belong to the selected DSH/model provider.
