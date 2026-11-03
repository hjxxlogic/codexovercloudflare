# Codex over Cloudflare

通过 Cloudflare 中转访问没有公网 IP 的远程 Codex，提供 CLI 和网页入口。默认生产地址为 **https://r.xlogic.cc**；原生程序和源码包见 [下载页](https://r.xlogic.cc/downloads/)。阅读入口见 [文档索引](docs/README.md)，部署与升级见 [发布操作](docs/RELEASE.md)。

## 本机快速开始

本机 Agent / CLI 使用 C++17，无 Node.js 运行依赖；需 CMake ≥ 3.16、Boost ≥ 1.71、OpenSSL、SQLite3、nlohmann/json ≥ 3.7。中转和网页开发需要 Node.js ≥ 22.17、npm；Codex 已验证版本为 `0.164.0`，Agent / CLI 不强制版本号，其他版本仍需兼容所用 app-server / TUI API。本机原生构建支持 Linux x86_64 和 Windows x64；Windows 使用 MSVC / vcpkg 构建并以 ZIP 分发，安装方式见[用户手册](docs/USER_GUIDE.md#windows-x64)；Wrangler 本地运行时还需要兼容的系统库，Ubuntu 20.04 用户参见 [开发说明](docs/DEVELOPMENT.md) 的容器方案。

```bash
sudo apt-get install build-essential cmake libboost-system-dev libssl-dev libsqlite3-dev nlohmann-json3-dev
npm ci
npm run build:native
npm run setup:local
npm run dev
```

打开 `http://127.0.0.1:8787`，点击“管理员登录”，输入 `.local/owner-secret`。以下登录命令显示配对码与授权地址；管理员在网页核对设备角色、名称、目标 A 后批准，程序自动领取长期有效、可撤销的专用凭证。

A 自己完成登录与运行，无需安装客户端：

```bash
./build/coc-agent login --relay http://127.0.0.1:8787 --name build-server \
  --config .local/agent.json --project /absolute/path/to/project --project-id my-project
./build/coc-agent run --config .local/agent.json
```

CC 填写留言申请访问，由管理员在批准时选择服务器：

```bash
./build/coc-client login --relay http://127.0.0.1:8787 --message "请授权开发服务器"
./build/coc-client projects
./build/coc-client connect --project my-project
./build/coc-client sessions
./build/coc-client stop A_ID~SESSION_ID
```

网页 CW 在“连接远程服务器”填写设备名称和留言后申请，无需获取 A 标识；管理员核对配对码、查看留言并选择服务器后批准。登录后打开顶部“历史”或“功能菜单 → 会话记录”，在面板顶部选择主机 / 项目、管理授权和新建会话；向上滚动接近消息顶部时自动异步加载更早内容。CC / CW 均可保存多份 A 授权并切换，凭证按角色和 A 隔离。管理身份单独认证，不直接控制 Codex 会话。设备凭证没有固定到期时间，直到 R 撤销；本地删除凭证不等于撤销。

提供 `coc-agent` / `coc-client` 两个程序；配置、systemd 与操作步骤见 [用户手册](docs/USER_GUIDE.md)。服务器必须先以 Agent 用户完成 Codex 配置。

## 验证

```bash
npm run build:native
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:tls
npm run test:codex
npm run test:native
```

端到端测试使用真实 Wrangler、SQLite 和 Chromium，以及不会执行命令的模拟 Codex。`test:codex` 与 `test:native` 使用真实本机 Codex，不提交模型任务。`test:native` 现在始终经过完整中继，需要先构建测试容器。可用 `npm run test:task` 验证真实文件任务；构建测试容器后，运行 `npm run test:native -- --relay --task` 验证真实原生 TUI 经完整本机中继的对话。这两项会调用已配置的模型服务。测试范围与验证边界见 [测试说明](docs/TEST_REPORT.md)。

## 当前边界

- 个人所有者模型，Agent 最多 16 个运行会话进程，另有 4 个历史读取进程；设备可分别撤销。
- 网页支持文本任务、流式事件、命令/文件审批、停止、同模式回放恢复和显式接管。
- CLI 只开放已声明的 RPC；配置/账号写入、任意命令 RPC、附件和跨会话历史访问被拒绝。
- CLI 首次附着后暂不支持再次附着现有 runtime；会返回明确错误。请结束旧会话再创建新会话，勿重复提交状态不明的任务。
- 网络单帧上限 256 KiB；本地 Codex RPC 缓冲上限约 8 MiB。大历史正文以引用和带 revision 的分块读取；超大控制响应返回单请求错误，不关闭共享上行。超出本地 RPC 缓冲仍会关闭对应 runtime。
- Agent 重启后会将原活动会话标记失败；CW 可从同一运行用户、同一项目的 Codex 本地历史显式恢复线程，不恢复旧进程或自动重发任务。
- 网页中的补充问题/MCP elicitation 暂不支持，会明确拒绝；不隐式批准操作。
- 代码修改留在远程服务器；不提供文件同步、端到端加密或不可信多用户隔离。

## 文档

- [文档索引与阅读路线](docs/README.md)

- [发布操作](docs/RELEASE.md)
- [用户手册](docs/USER_GUIDE.md)
- [开发与本机测试](docs/DEVELOPMENT.md)
- [测试说明](docs/TEST_REPORT.md)
- [项目需求](docs/REQUIREMENTS.md) 与 [技术架构](docs/ARCHITECTURE.md)：需求边界与设计依据，实施状态以当前协议和测试报告为准。

当前协议见 [可靠传输](docs/RELIABLE_TRANSPORT.md)，测试入口见 [测试说明](docs/TEST_REPORT.md)，部署要求见 [发布操作](docs/RELEASE.md)。

Linux Agent / CLI 默认自动更新所连接中继的发行版本；配置 `"autoUpdate": false` 可关闭。安装权限、检查间隔及回退方式见 [用户手册](docs/USER_GUIDE.md#原生程序自动更新)。
