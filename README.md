# Codex over Cloudflare

通过 Cloudflare 中转访问没有公网 IP 的远程 Codex，提供 CLI 和网页入口。默认生产地址为 **https://r.xlogic.cc**；本仓库目前提供可本机运行的开发版本，不代表该域名已经部署。

## 本机快速开始

需要 Node.js ≥ 22.17（建议 24）、npm，以及 Codex `0.164.0`。Agent 可运行在 Linux；Wrangler 本地运行时还需要兼容的系统库，Ubuntu 20.04 用户参见 [开发说明](docs/DEVELOPMENT.md) 的容器方案。

```bash
npm ci
npm run setup:local
npm run dev
```

打开 `http://127.0.0.1:8787`。本地所有者密钥保存在 `.local/owner-secret`；开发秘密与状态目录已被 Git 忽略。

在另一个终端登录并生成服务器登记码：

```bash
npm run coc -- login --relay http://127.0.0.1:8787
npm run coc -- enroll build-server
```

使用登记码配置 Agent，`--project` 指向实际远程项目目录：

```bash
npm run coc -- agent-enroll --relay http://127.0.0.1:8787 \
  --config .local/agent.json --project /absolute/path/to/project \
  --project-id my-project
npm run agent -- .local/agent.json
```

Agent 在线后，在网页选择主机和项目、创建会话即可。CLI 入口：

```bash
npm run coc -- projects --host build-server
npm run coc -- connect --host build-server --project my-project
npm run coc -- sessions --host build-server
npm run coc -- stop HOST_ID~SESSION_ID
```

`login` 与设备登记交互式输入秘密，不通过命令参数传递。服务端必须先以 Agent 的运行用户完成 Codex 配置，并确认 `codex` 能正常使用。

## 验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:codex
npm run test:native
```

端到端测试使用真实 Wrangler、SQLite 和 Chromium，以及不会执行命令的模拟 Codex。`test:codex` 与 `test:native` 使用真实本机 Codex，不提交模型任务。可用 `npm run test:task` 验证真实文件任务；构建测试容器后，运行 `npm run test:native -- --relay --task` 验证真实原生 TUI 经完整本机中继的对话。这两项会调用已配置的模型服务。具体证据与未验证事项见 [测试记录](docs/TEST_REPORT.md)。

## 当前边界

- 个人所有者模型，每台主机最多 4 个活跃会话；设备可分别撤销。
- 网页支持文本任务、流式事件、命令/文件审批、停止、同模式回放恢复和显式接管。
- CLI 只开放已声明的 RPC；配置/账号写入、任意命令 RPC、附件和跨会话历史访问被拒绝。
- CLI 首次附着后暂不支持再次附着现有 runtime；会返回明确错误。请结束旧会话再创建新会话，勿重复提交状态不明的任务。
- 单帧上限 256 KiB，超大 Codex 输出会终止对应 runtime；尚未实现架构规划中的分片。
- Agent 重启后会将原活动会话标记失败；当前未实现通过新 runtime 恢复旧 Codex 线程。
- 网页中的补充问题/MCP elicitation 暂不支持，会明确拒绝；不隐式批准操作。
- 代码修改留在远程服务器；不提供文件同步、端到端加密或不可信多用户隔离。

## 文档

- [用户手册](docs/USER_GUIDE.md)
- [开发与本机测试](docs/DEVELOPMENT.md)
- [测试记录](docs/TEST_REPORT.md)
- [项目需求](docs/REQUIREMENTS.md) 与 [技术架构](docs/ARCHITECTURE.md)：完整目标，部分能力尚待实现。
