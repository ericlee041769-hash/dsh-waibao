# dsh-waibao · DSH 外包

**Codex 分配任务，DSH 桌面执行；同一会话继续，完成后回来验收。**

[GitHub 源码](https://github.com/ericlee041769-hash/dsh-waibao) · [Gitee 源码](https://gitee.com/sensenlee/dsh-waibao) · [下载安装包与演示视频](https://github.com/ericlee041769-hash/dsh-waibao/releases/tag/v0.1.0)

把原本藏在命令行里的委派，放进看得见的 DSH 桌面工作区。

- **桌面可见**：会话出现在原生工作区和侧栏，正文、工具过程和用量都由 DSH 展示。
- **上下文续接**：后续任务重用保存的 session binding，接着原会话执行。
- **完成回调**：任务结束后通知发起任务的 Codex 聊天，交由 Codex 检查产物。
- **历史接入**：把已有 headless 会话加入桌面工作区，再继续工作。
- **保留模型**：使用已选 provider/model；续接时检查是否发生切换。

## 什么情况下有用

当你希望 Codex 负责拆解、评审和验收，DSH 接手实现或检查时：你能看见执行过程、减少重复交代背景，并在完成后继续推进。多轮功能开发、长时间测试和检查更适合这条流程；单轮简单问答的收益较小。

它也让两个产品各用现有模型和工具配置。费用由任务分工、上下文长度和实际模型计费共同决定。

## 安装

首版支持 **Windows、Node.js 24+**。已实测 DeepSeek Harness Desktop **0.2.0-rc.2**；完成回调需要 Codex 桌面及已启用的 Codex App Tools。其他版本尚未验收。

从 [v0.1.0 发布页](https://github.com/ericlee041769-hash/dsh-waibao/releases/tag/v0.1.0) 下载 `dsh-waibao-0.1.0.tgz`，在 DSH 桌面“添加插件”中填入本地 `.tgz` 路径。也可以用 **DSH 桌面自带 CLI**：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add 'D:\Downloads\dsh-waibao-0.1.0.tgz'
```

正常退出并重开 DSH。全局独立安装的旧版 `dsh` 无权管理桌面 profile，请使用上述桌面 CLI。插件遵循上游的 [bundle 安装规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

安装 Codex 技能：

```powershell
$plugin = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-waibao"
node "$plugin\bin\install-skill.mjs"
node "$plugin\bin\cli.mjs" describe
```

在 Codex 新聊天中说：**“用 dsh-waibao 把这个任务委派给 DSH，完成后帮我验收。”**

技能安装器只写入 `~/.codex/skills/dsh-waibao/SKILL.md`（支持 `CODEX_HOME`）。更新插件后重跑安装器，刷新技能中的安装路径。

## 手动调用与续接

创建提示词文件，再写任务 JSON。以下为路径示例，替换成你的实际工作区：

```json
{
  "workspace": "D:\\code\\demo",
  "workspaceTitle": "外包演示",
  "title": "检查实现与测试",
  "requestId": "demo-round-1",
  "bindingPath": "D:/code/demo/work/dsh-session.json",
  "promptFile": "D:/code/demo/work/round1.txt"
}
```

```powershell
node "$plugin\bin\cli.mjs" run 'D:\code\demo\work\task.json'
```

续接时保留 `bindingPath`，使用新的 `requestId` 和提示词文件。不要复制历史正文、替换 session ID 或同时驱动同一会话。只有新会话可用 `selection: {provider, model, reasoningEffort}` 指定模型；默认采用桌面的当前选择。

`adopt <JSON>` 接受 `workspace`、`sessionId` 和可选 `workspaceTitle`。先确认旧 headless 进程已结束，并使用原始工作目录。接入本身不调用模型。

## 完成回调

技能会在 Codex 环境中调用 `bin/job.mjs run <job.json>`，登记原始聊天、执行命令和输出路径。进程结束后，通过本机 Codex App Tools 发出一次完成事件。无需定时器或轮询。

`job.mjs status <id>` 查看已有记录；`deliver <id>` 处理尚未投递的完成事件。投递结果不确定时先核对历史，拒绝盲目重发。应用关闭或 Codex 重启可能使已有连接失效。

## 数据与权限

插件通过带随机令牌的 Windows 本地命名管道通信，没有 HTTP 端口。连接记录与回调状态位于 `~/.dsh/dsh-waibao/`；`DSH_WAIBAO_DATA_DIR` 可将双方改到同一自定义目录。

提示词交给 DSH 原生 Agent，使用当前账号、模型、工具权限与审批策略；模型费用由该 provider 收取。绑定和输出由调用方写在任务工作区。令牌、完整日志、个人项目和会话数据不要提交到公开仓库。

断线不代表任务停止：客户端在收到 `done` 前断开会明确报错，重试前应检查桌面会话。忙碌会话、重复 requestId、未知 session 和工作区不匹配会被拒绝。

## 缓存与费用

复用 session 能保持任务连续性。实际缓存命中率还取决于模型路由、历史变化、压缩与服务商规则。插件不承诺固定命中率或节省比例；桌面显示和命令行 usage 是可核查的实际用量。

## 开发

运行时零第三方依赖，直接加载 ESM 源码，无需构建：

```sh
npm run check
npm test
npm pack
```

`src/host.mjs` 负责原生会话和 IPC；`bin/cli.mjs` 负责任务绑定；`bin/job.mjs` 负责完成记录和回调；`src/paths.mjs` 让两端共享同一数据路径；`bin/read-run.mjs` 读取有界摘要；技能负责调用流程。没有另建聊天 UI、会话数据库或轮询服务。

演示视频源码和重新渲染说明见 [promo/README.md](promo/README.md)。[社区发布文案](docs/community-post.md)和[视频标题与简介](docs/video-description.md)可直接使用。

MIT License。社区插件，项目名称中的 DSH 和 Codex 用于说明兼容产品。
