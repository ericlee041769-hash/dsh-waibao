# Changelog

## 0.1.3 — 2026-10-24

- 新增 `job.mjs spawn <spec.json>` 并行启动独立子任务，各自返回启动回执或错误；单项失败不阻断其他任务。`list <workspace>` 汇总当前父聊天下的任务、模型、状态与消息投递情况。
- 委派子会话增加执行期间可调用的 `send_to_parent({message})`，重要发现即时发送给父 Codex；消息带独立 ID 和会话/请求身份，投递状态持久化，父任务可按 job ID 用 `append` 回复或 `stop` 停止。
- 移除模型绑定校验和 `restore-selection` 路径。接受 DSH 任意已配置 provider/model；省略选择时使用实际当前选择，续接可显式换模型，保留原会话上下文。
- 更新技能为并行创建、执行中双向沟通、按任务续接与验收；新增真实 CLI/协调进程并发、消息隔离及投递失败行为测试，保留用户审批规则。

## 0.1.2 — 2026-10-19

- 修复委派会话遇到工具审批时轮次卡住：Host 以 `approval/request` waterfall 的 prepend 应答器接管委派会话的一次性审批，非委派会话仍交给原有桌面应答链，不改变审批策略、审计和服务端 `never`/`ask` 判定。
- 委派审批等待期间输出结构化 `approval` 事件；协调器沿子进程标准输出实时读取（不轮询），向发起任务的 Codex 线程发送一次审批通知，并在 job 记录中保存通知/决定状态。
- 新增 `cli.mjs pending` 有界查询和 `cli.mjs decide`：按 workspace + sessionId + approvalId（可校验 requestId）明确选择 `allowed-once` 或 `rejected`，决定后原请求在原会话恢复；取消、重复决定和过期决定分别返回明确状态。
- 通知只尝试一次，失败时记录 `notificationError` 而不自动重发；完成回调附带本轮审批摘要，`read-run` 按 job ID 返回审批状态与结果。
- 经原生 `user-questions/request` 支持委派会话的 `ask_user_question`：完整展示问题/选项、结构化回答、拒绝或取消，与权限审批分开，不默认批准；同样一次性通知并记录通知/决定状态。
- 新增 job 级 `pending`、`append`、`answer`、`stop`：自动读取 job binding，不要求调用方手拼会话 ID。`append` 用原生 `mode:'steer'` 与独立 requestId，接收/消费/重复语义明确；`stop` 用原生 `cancel(keepInbox:true)` 与 `updateQueue(remove)` 取消当前委派，只丢弃本委派未消费追加，保留文件、历史和同会话续聊能力。
- job 记录区分 `waiting`/`running`/`cancelled`/`completed`/`failed`，取消仍只发一次完成回调；`read-run` 暴露问题与等待状态。
- 新增伪造 Host/AppTools 的审批、问题、steer 与 stop 行为测试，覆盖等待→通知→明确决定→恢复→一次完成回调、拒绝、取消、并发隔离、非委派隔离、通知送达不确定、重复追加、停止后未消费追加不执行和其他会话不受影响。版本升到 0.1.2。

## 0.1.1 — 2026-10-18

- 新增 `job.mjs submit <spec.json>` 单份规格入口：自动读取实际 `CODEX_THREAD_ID` 与 Node，生成 request/job ID、binding、任务/提示词/job 规格和每轮证据，并在后台隐藏窗口启动协调器。正常委派不再手写第二份 job JSON、提示词文件、线程 ID 或执行命令。
- 任务路径固定为 `workspace/work/dsh-waibao/<thread>/<task>/`；同线程同 task 复用 binding，不同 task/线程隔离，每轮证据独立。提交侧拒绝同一 task 的并发轮次，启动失败时释放占用。
- 前台回执给出 job ID、task、实际启动状态、binding 与证据路径；后台注册成功后才返回。
- `read-run.mjs` 可直接按 job ID 读取有界摘要和证据路径，未知 usage 仍为 null。
- Codex 技能改为授权范围内的主策划/执行者分工：首轮给足目标、路径与验收，同任务只发差量，DSH 简要回报，Codex 有界验收。
- README 用单规格入口替换旧双 JSON 教程，并说明上下文与证据策略。
- 新增 `cli.mjs restore-selection`：在用户确认后恢复已有空闲会话的绑定配置，保留会话 ID、历史和计费路由，不执行模型轮次。技能明确要求修正和验收继续原任务，不因上下文变长另开会话。

## 0.1.0 — 2026-10-13

- 原生 DSH 桌面会话委派、同一 session 续接和历史接入。
- 保留会话模型，阻止重复请求和并发驱动。
- Codex 完成回调与本地持久化记录。
- 标准 bundle、便携用户路径、Codex 技能安装器。
- 首版面向 Windows；实测 DSH Desktop 0.2.0-rc.2。
