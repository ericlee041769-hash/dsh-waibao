# dsh-waibao · DSH 外包

**Codex 并行分配任务，DSH 子代理执行中交流；按任务追加、停止和验收。**

[GitHub 源码](https://github.com/ericlee041769-hash/dsh-waibao) · [Gitee 源码](https://gitee.com/sensenlee/dsh-waibao) · [发布页](https://github.com/ericlee041769-hash/dsh-waibao/releases)

把原本藏在命令行里的委派，放进看得见的 DSH 桌面工作区。

- **桌面可见**：会话出现在原生工作区和侧栏，正文、工具过程和用量都由 DSH 展示。
- **单份规格**：一次 `submit` 自动生成绑定、任务、提示词、job 记录和证据路径，并后台启动协调器。
- **上下文续接**：同一线程、同一 workspace、同一 task 自动复用 session binding，后续只发差量。
- **完成回调**：一轮结束后通知发起任务的 Codex 聊天，由 Codex 按验收要求检查产物。
- **并行子任务**：`spawn` 同时启动多个独立任务，`list` 汇总本父聊天的子任务状态。
- **执行中交流**：子代理用 `send_to_parent` 主动汇报发现与阻塞；Codex 用 `append` 回复指定子代理。
- **审批不卡死**：委派会话遇到工具审批时通知发起任务的 Codex，按用户明确决定允许一次或拒绝后原会话恢复。
- **历史接入**：把已有 headless 会话加入桌面工作区，再继续工作。
- **自由模型**：使用 DSH 实际选择，支持任意已配置 provider/model；同会话续接可以切换模型。

## 什么情况下有用

Codex 负责拆解、评审和验收，DSH 接手实现、调查或测试时，你能看见执行过程、减少重复交代背景，并在完成后继续推进。多轮功能开发、长时间测试和检查更适合这条流程；单轮简单问答或一步操作由 Codex 自己做更省。

两个产品各用现有模型和工具配置。费用由任务分工、上下文长度和实际模型计费共同决定。

## 安装

支持 **Windows、Node.js 24+**。0.1.3 已在 DeepSeek Harness Desktop 0.2.1-rc.2 完成真实模型验收：三任务并发、六条主动消息、两次父回复确认及独立停止；本地集成测试 28/28 通过。详见[验收记录](docs/verification-0.1.3.md)。完成回调需要 Codex 桌面及已启用的 Codex App Tools。

从[发布页](https://github.com/ericlee041769-hash/dsh-waibao/releases)下载最新的 `dsh-waibao-<version>.tgz`，在 DSH 桌面“添加插件”中填入本地 `.tgz` 路径。也可以用 **DSH 桌面自带 CLI**：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add 'D:\Downloads\dsh-waibao-0.1.3.tgz'
```

正常退出并重开 DSH。全局独立安装的旧版 `dsh` 无权管理桌面 profile，请使用上述桌面 CLI。插件遵循上游的 [bundle 安装规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

安装 Codex 技能：

```powershell
$plugin = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-waibao"
& node "$plugin\bin\install-skill.mjs"
& node "$plugin\bin\cli.mjs" describe
```

在 Codex 新聊天中说：**“用 dsh-waibao 把这个任务委派给 DSH，完成后帮我验收。”**

技能安装器只写入 `~/.codex/skills/dsh-waibao/SKILL.md`（支持 `CODEX_HOME`）。更新插件后重跑安装器，刷新技能中的安装路径。

## 并行创建子任务

把独立工作分给不同 `task`，每个提示词写清文件责任和验收要求。修改同一工作区时，告诉子代理还有其他代理同时工作。示例 `batch.json`：

```json
{
  "workspace": "D:\\code\\demo",
  "tasks": [
    {"task": "implementation", "prompt": "实现 X，负责 src/x.mjs。重要发现及时调用 send_to_parent。", "acceptance": "X 正常工作"},
    {"task": "investigation", "prompt": "只读调查 Y。重要发现及时调用 send_to_parent。", "acceptance": "给出源码位置与结论"}
  ]
}
```

```powershell
& node "$plugin\bin\job.mjs" spawn 'D:\code\demo\work\batch.json'
& node "$plugin\bin\job.mjs" list 'D:\code\demo'
```

`spawn` 并行启动各项，返回 `{workspace,tasks:[{ok:true,...回执}|{ok:false,task,error,...已知任务信息}]}`。其中一项失败，其余项仍独立启动；任一失败会使命令非零退出，调用方要逐项检查回执。不同 task 各有会话和后台协调进程，可以同时执行；同一 task 运行中拒绝重入。

`list` 返回当前父聊天、指定 workspace 下的 `agents`，包括 task、job/session ID、实际模型、运行状态、消息数和投递错误数。运行中的任务用 `append` 交流或 `stop` 停止，空闲任务用同一 task 的 `submit` 继续。

## 委派或续接一轮

写一份规格 JSON，路径换成实际工作区：

```json
{
  "workspace": "D:\\code\\demo",
  "task": "check-startup",
  "prompt": "本轮目标、范围、需要拍板的点和准确文件路径。",
  "acceptance": "Codex 要验收的内容。",
  "workspaceTitle": "外包演示",
  "title": "检查启动流程"
}
```

```powershell
& node "$plugin\bin\job.mjs" submit 'D:\code\demo\work\round1.json'
```

- `workspace` 是已存在的绝对目录；`task` 是稳定 slug，续接同一任务时保持不变；`prompt` 是本轮内联指令；`acceptance` 是验收要求。
- 每轮均可用 `selection: {provider, model, reasoningEffort}` 指定 DSH 已配置的任意模型。省略时，新任务用桌面当前默认选择，续接用该会话的当前选择；桌面中切换模型后可直接续接，同一会话保留上下文。插件没有模型白名单，也不恢复旧路由。
- `submit` 从当前 Codex 环境读取真实线程 ID 和 Node，自动生成 request/job ID、binding、任务/提示词/job 规格及证据路径。不需要再写第二份 JSON、提示词文件、线程 ID 或执行命令。
- 前台输出一行紧凑 JSON 回执：`jobId`、`task`、`status`、`bindingPath`、`sessionId` 和证据路径。`status: "running"` 表示后台协调器已注册并确认启动；非零退出表示提交或启动失败。
- 路径固定为 `workspace/work/dsh-waibao/<thread>/<task>/`。同线程同 task 复用 `binding.json`，不同 task 或线程相互隔离；每轮证据在 `rounds/<jobId>/`，不覆盖前一轮。
- 同一 task 有未结束的轮次时，新的提交会被拒绝。等完成回调或记录中的退出状态后再发差量。启动确认超时属于“状态未知”：占位保留供人工检查，不能自动重试。失败或断连后不要改 binding 的 session ID，也不要自动重试花费。
- 收到成功回执后，Codex 可以继续其他工作或结束本轮；不需要轮询、定时器或 heartbeat。

`submit` 内部用后台协调器调用 `bin/job.mjs run <job.json>`；该内部规格（线程 ID、命令、三个证据路径）由 `submit` 生成，正常委派不必手写。`adopt <JSON>` 只把历史 headless 会话接入桌面，不运行提示词；继续该会话仍需手写一次内部 task/job 规格（`cli.mjs run` + `job.mjs run`），之后的任务沿用保存的 binding。

## 工具审批

委派会话中的工具调用可能触发审批。该轮会保持运行，不算完成；Host 接管这个委派会话的审批等待，协调器向发起任务的 Codex 聊天发送一次 `[DSH_WAIBAO_APPROVAL:<jobId>:<approvalId>]` 通知，job 记录同步保存审批、通知和决定状态。用户仍在原 DSH 会话里执行，不新建会话。

Codex 先把工具、调用、原因和会话告诉用户，等用户明确选择后再操作。查询和决定都只传 job ID，CLI 自动从 job 记录和 binding 读取 workspace/session：

```powershell
& node "$plugin\bin\job.mjs" pending JOB_ID
```

决定时写：

```json
{ "approvalId": "通知中的审批 ID", "outcome": "allowed-once" }
```

```powershell
& node "$plugin\bin\job.mjs" answer JOB_ID 'D:\code\demo\work\decide.json'
```

`outcome` 只能是 `allowed-once` 或 `rejected`。Host 校验 workspace、session 和当前 run requestId；决定沿原生 `approval/request` waterfall 返回，原请求在原会话恢复，审计仍由 DSH 审批服务写入。只有发起该委派的 Codex 线程能查询和决定。相同决定重复提交幂等，冲突决定、取消、过期或旧轮次请求会被拒绝。通知只尝试一次；送达不确定时记录 `notificationError`，不自动重发，改用 `pending` 查询并等待用户决定。

原生 waterfall 每个请求只允许一个应答者。委派会话由上述 Codex 入口作答；非委派会话和普通桌面会话仍走原有桌面审批界面，审批策略、`never`/`ask` 判定和审计都未被改写。

## 普通问题、追加与停止

子代理运行时可调用 `send_to_parent({message})`，将重要发现、阻塞或协调请求即时发给父 Codex。通知标记为 `[DSH_WAIBAO_MESSAGE:<jobId>:<messageId>]`，带任务、会话和本轮请求身份。父任务可立即用下述 `append` 回复指定 job，同时继续其他工作。工具只在正在执行的委派子会话中注册，结束后释放。

消息及投递状态保存于 job 的 `parentMessages`。`sent` 表示写入协调器通道；`notifiedAt` 表示已通知父聊天，`notificationError` 表示投递失败或不确定。`pending`、`status` 和 `read-run` 可以读取记录，`list` 汇总错误数。每条消息只尝试投递一次，按 message ID 区分；失败不会自动重发。普通进度留在 DSH 日志中，重要发现主动发送。

`ask_user_question` 是普通执行问题，不是权限审批。委派遇到问题时协调器发送一次 `[DSH_WAIBAO_QUESTION:<jobId>:<questionId>]` 通知，包含完整问题、选项和调用 ID。Codex 可在用户既有授权内回答普通执行问题；真实权限、外部副作用和个人选择仍由用户明确决定。

```powershell
& node "$plugin\bin\job.mjs" pending JOB_ID
```

`pending` 返回 `runState`（`running`/`waiting`/`cancelled`/`completed`/`failed`/`ended`）、分开的 `questions`、`approvals` 和 `appends`（`accepted` 已接收、`consumed` 已消费、`discarded` 已丢弃）。回答用绝对 JSON：

```json
{ "questionId": "通知中的问题 ID", "outcome": "answered", "answers": [{ "id": "q1", "selected": ["选项 A"] }] }
```

```powershell
& node "$plugin\bin\job.mjs" answer JOB_ID 'D:\code\demo\work\answer.json'
```

`outcome` 可为 `answered`、`rejected` 或 `cancelled`；真实审批则用 `{"approvalId":"...","outcome":"allowed-once"|"rejected"}`。同一决定重复提交幂等，冲突决定会报错。

执行中可追加差量：

```json
{ "prompt": "追加的这部分指令", "requestId": "可选稳定 ID" }
```

```powershell
& node "$plugin\bin\job.mjs" append JOB_ID 'D:\code\demo\work\delta.json'
```

追加走原生 steer，只作用于准确的当前委派 session 和 run；重复 `requestId` 不重复执行，回执区分已接收与已消费。空闲后继续同一任务应使用 `submit`，不要用 `append` 开新轮次。

停止当前委派：

```powershell
& node "$plugin\bin\job.mjs" stop JOB_ID
```

使用原生 cancel 与队列移除，取消模型/工具/等待中的交互，只丢弃本委派尚未消费的追加，不删除文件或会话历史，不影响其他桌面队列和会话。完成回调仍只发一次，`runState` 为 `cancelled`；之后可用同一 task 和 binding 继续 `submit`。

## 上下文策略

- 一个稳定 `task` 对应一个会话 binding；续接只追加本轮差量和具体发现，不重贴历史正文。
- 实现、审查修正和验收沿用同一 `task`，复用上下文与缓存；不要因为历史变长或模型设置变化另开会话。独立工作或用户明确要求时再新建 `task`。
- 每轮证据独立保存；完成回调只带 job ID 和验收要求，Codex 用 `read-run` 按需读取有界摘要与路径。
- 未知 usage 保持 `null`；缓存读取、未缓存输入和输出分别记录，不据此声称固定节省比例。

## 完成回调

协调器在一轮进程结束后，通过本机 Codex App Tools 发出一次完成事件。Codex 按技能要求运行：

```powershell
& node "$plugin\bin\read-run.mjs" JOB_ID
```

输出包含本轮 session、步数、有界最终文本、实际 usage 摘要、`runState` 与等待/审批/问题状态，以及 job 状态、退出码、binding 和证据路径。也可以继续传绝对 stdout 路径读取旧日志。

`job.mjs status <id>` 查看已有记录；`deliver <id>` 处理尚未投递的完成事件。投递结果不确定时先核对历史，拒绝盲目重发。应用关闭或 Codex 重启可能使已有连接失效。

## 数据与权限

插件通过带随机令牌的 Windows 本地命名管道通信，没有 HTTP 端口。连接记录与回调状态位于 `~/.dsh/dsh-waibao/`；`DSH_WAIBAO_DATA_DIR` 可将双方改到同一自定义目录。

提示词交给 DSH 原生 Agent，使用当前账号、模型、工具权限与审批策略；模型费用由该 provider 收取。binding、任务规格和输出写在调用方指定的工作区。令牌、完整日志、个人项目和会话数据不要提交到公开仓库。

断线不代表任务停止：客户端在收到 `done` 前断开会明确报错，重试前应检查桌面会话。忙碌会话、重复 requestId、未知 session、工作区不匹配和同一 task 的并发提交会被拒绝。

## 缓存与费用

复用 session 能保持任务连续性。实际缓存命中率还取决于模型路由、历史变化、压缩与服务商规则。插件不承诺固定命中率或节省比例；桌面显示和命令行 usage 是可核查的实际用量。

## 开发

运行时零第三方依赖，直接加载 ESM 源码，无需构建：

```sh
npm run check
npm test
npm pack
```

`src/host.mjs` 负责原生会话、IPC、委派专用消息工具、审批/问题应答、steer 追加与 stop 取消；`bin/cli.mjs` 执行任务绑定并查询/决定审批；`bin/job.mjs` 负责并行 spawn、父聊天任务 list、后台协调、消息/审批/问题投递、job 级 pending/append/answer/stop、完成记录和回调；`src/paths.mjs` 让两端共享同一数据路径；`bin/read-run.mjs` 按 job ID 或日志读取有界摘要；技能负责调用流程。

测试使用假桌面 Host 和假 App Tools bridge，不调用真实付费模型。通过真实 CLI、后台协调进程和本地管道验证三个独立任务同时运行、单 task 重入拒绝、父聊天列表隔离、部分启动失败、子消息完成前送达与身份隔离、父回复和停止隔离、投递失败持久化、任意模型与桌面改模后续接，以及断连明确报错。原有审批、问题、去重、停止后续接和用量测试继续保留。

演示视频源码和重新渲染说明见 [promo/README.md](promo/README.md)。[社区发布文案](docs/community-post.md)和[视频标题与简介](docs/video-description.md)可直接使用。

MIT License。社区插件，项目名称中的 DSH 和 Codex 用于说明兼容产品。
