# 用户手册

> 生产中转地址：**https://r.xlogic.cc**。生产网站已部署，当前为 0.2.0 开发预览版；本机开发地址为 `http://127.0.0.1:8787`。生产登录密钥由中转管理员提供，不与本地开发密钥通用。

## 1. 服务端、客户端与网页

| 组件  | 运行位置                               | 用途                                           |
| ----- | -------------------------------------- | ---------------------------------------------- |
| Agent | 已安装并配置 Codex 的远程 Linux 服务器 | 主动连接中转，管理项目、Codex 进程和历史。     |
| CLI   | 用户电脑                               | 登录、登记主机、选择项目并启动原生 Codex TUI。 |
| 网页  | 电脑或手机浏览器                       | 文本任务、流式输出、命令/文件审批和会话管理。  |
| 中转  | `r.xlogic.cc`                          | 认证、设备登记、网页和实时消息中转。           |

项目文件和执行命令都在**远程服务器**。本机目录不会自动上传，远程变更不会自动下载。服务器仅需出站 HTTPS/WSS，无需公网 IP 或入站端口。

在线 Markdown 用户手册以 UTF-8 纯文本提供，可直接在浏览器阅读；也可下载后用支持 UTF-8 的编辑器打开。

## 2. 安装与准备

Agent 和 CLI 为 C++ 原生程序。发布包下载入口：[https://r.xlogic.cc/downloads/](https://r.xlogic.cc/downloads/)。目前提供 Ubuntu 20.04 和 Debian 12 的 Linux x86_64 包，以及源码包；按发行版选择，并用 `sha256sum -c SHA256SUMS --ignore-missing` 校验。

解压二进制包后执行 `sudo install -m 0755 coc coc-agent /usr/local/bin/`，后文 `./build/coc` / `./build/coc-agent` 可直接替换为 `coc` / `coc-agent`。包不包含系统动态库，先用 `ldd coc coc-agent` 检查依赖。

也可从源码编译（Debian / Ubuntu 示例）：

```bash
sudo apt-get install build-essential cmake libboost-system-dev libssl-dev libsqlite3-dev nlohmann-json3-dev
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 2
./build/coc --help
# 可选：安装到 /usr/local/bin
sudo cmake --install build --prefix /usr/local
```

编译要求 C++17、CMake ≥ 3.16、Boost ≥ 1.71、OpenSSL、SQLite3、nlohmann/json ≥ 3.7。生成 `build/coc-agent` 和 `build/coc`。安装后可直接使用 `coc-agent` / `coc`；仅需在运行平台安装相应动态库，**运行本机程序不需要 Node.js**。当前验证 Linux x86_64。

CLI 和 Agent 使用 Codex `0.164.0`；CLI 仅在启动 TUI 时需要本机 Codex。网页用户不需要安装本地 Codex。中转 / 网页开发需另外执行 `npm ci`，要求 Node.js ≥ 22.17。

服务器先使用与 Agent 相同的系统用户确认 Codex 正常：

```bash
codex --version
codex
```

完成服务器自己的 Codex 登录或模型供应商配置，并准备可读写的项目目录。网页用户不需要安装本地 Codex。

中转管理员需先配置域名、部署 Worker 和设置所有者密钥，参见 [开发与部署准备](DEVELOPMENT.md)。普通使用者无需 Cloudflare API Token。

### 本机体验

```bash
npm ci
npm run setup:local
npm run dev
```

打开 `http://127.0.0.1:8787`。本地所有者密钥位于 `.local/owner-secret`。后文登录和登记命令中的 `https://r.xlogic.cc` 在本机体验时均替换为 `http://127.0.0.1:8787`。

Ubuntu 20.04 无法直接运行新版 Wrangler 的 workerd，使用 [容器方案](DEVELOPMENT.md)。

### 从 TypeScript 版本迁移

停止旧 Agent 后，用 `coc-agent /原路径/agent.json` 启动，配置字段、默认中转、CLI 凭据路径和 SQLite 文件保持不变。请保留 `dataDir`；重启会把旧的活动会话标记失败，不会自动恢复进程。`npm run coc -- ...` 和 `npm run agent -- ...` 保留为二进制的开发快捷入口，须先完成 C++ 构建。systemd 改为直接执行安装后的 `/usr/local/bin/coc-agent`，无需 npm。

## 3. 登录与认证

| 凭据         | 获取方式                              | 用途                                |
| ------------ | ------------------------------------- | ----------------------------------- |
| 所有者密钥   | 中转管理员配置；本地由 setup 脚本生成 | 网页或 CLI 登录。                   |
| 一次性登记码 | 已登录 CLI 的 `enroll` 命令生成       | Agent 首次登记，5 分钟有效。        |
| 设备令牌     | Agent 登记成功后自动保存              | 服务器后续连接；每台设备独立。      |
| 会话票据     | 客户端自动申请                        | 连接指定会话，一次使用、60 秒有效。 |

Codex API Key 不用于中转登录，也不上传到中转配置中。登录密钥与登记码交互式输入；不要把它们写进命令参数、网址或 Git。

## 4. 服务端接入流程

### 4.1 登录并生成登记码

在任意装有 C++ 客户端的可信电脑上执行：

```bash
./build/coc login --relay https://r.xlogic.cc
./build/coc enroll build-server
```

第一条命令提示输入所有者密钥。第二条返回 `code`、主机 ID 和有效期；把登记码用于目标服务器，使用后立即失效。

### 4.2 在服务器登记 Agent

在服务器的仓库目录执行，替换项目的真实绝对路径：

```bash
./build/coc agent-enroll --relay https://r.xlogic.cc \
  --config .local/agent.json --project /srv/projects/my-project \
  --project-id my-project
```

按提示输入登记码。命令创建权限为 `0600` 的 JSON 配置，包含设备令牌；已有文件时拒绝覆盖。

配置示例见 [agent.example.json](../examples/agent.example.json)。登记后可在 `projects` 数组追加项目，每项包含唯一的 `id`、显示名 `name` 和远程绝对路径 `path`。客户端只能选择这些项目，不能指定任意路径。

### 4.3 启动 Agent

```bash
./build/coc-agent .local/agent.json
```

出现 `Agent connected` 后，在已登录的客户端检查：

```bash
./build/coc hosts
./build/coc projects --host build-server
```

确认主机在线且项目可见。首次前台验证成功后，可按 [systemd 模板](../examples/coc-agent.service) 调整运行用户、源码路径、Codex PATH 与配置路径，交由系统常驻运行。

每个数据目录只运行一个 Agent。不要将 Codex app-server 直接开放到公网。

## 5. CLI 客户端流程

### 5.1 连接远程项目

```bash
./build/coc login --relay https://r.xlogic.cc
./build/coc hosts
./build/coc projects --host build-server
./build/coc connect --host build-server --project my-project
```

`connect` 创建 CLI 会话并显示会话 ID，然后启动本机原生 Codex TUI。核对远程主机和项目后输入任务；操作在服务器执行。

可先发送只读任务：

```text
阅读项目，说明目录结构和测试方法，暂时不要修改文件。
```

命令和文件操作审批会转发到终端。需要操作本机附件、图片或外部编辑器时，当前远程模式不支持；全局配置和账号修改等 RPC 也会被拒绝。

### 5.2 查询、停止与退出

```bash
./build/coc sessions --host build-server
./build/coc stop HOST_ID~SESSION_ID
./build/coc logout
```

将 `HOST_ID~SESSION_ID` 替换为列表中的完整 ID。`stop` 结束会话，不回滚已修改文件。退出登录不等于停止任务，需要停止时先执行 `stop` 并确认结果。

当前 `attach` 接口只允许 CLI runtime 的首次附着，已使用过的 CLI 会话再次附着会返回 `CLI_REATTACH_UNSUPPORTED`。断线后先查询状态，不要重发最后一条任务；需要新会话时先确认旧任务和文件状态，再结束旧会话。

CLI 凭据保存在 `~/.config/coc/credentials.json`，默认登录有效期为 8 小时；过期后重新登录。

## 6. 网页端流程

1. 打开 **https://r.xlogic.cc**，输入所有者密钥登录。
2. 选择在线主机与项目；主机登记目前通过第 4 节 CLI 完成。
3. 点击“创建网页会话”，核对显示的远程项目。
4. 输入任务并点击“发送”，查看流式回复、工具事件和代码差异。当前差异以事件文本显示。
5. 出现命令或文件审批时，检查详情后点击“允许”或“拒绝”，等待确认。
6. 使用“停止本轮”中断当前轮次；使用“结束会话”关闭该 runtime。

当前网页只支持文本输入和命令/文件审批。其他交互问题或 MCP elicitation 会明确拒绝并显示警告，不会自动同意。

关闭页面不会立即停止任务。重新打开网站、选择原网页会话后会同步当前状态、未决审批及保留事件。超出保留范围时显示历史缺口。原 CLI 会话不能在网页中控制，反之亦然。

## 7. 控制权与断线恢复

一个会话同时只有一个控制端。被其他设备占用时，网页显示冲突；确认后点击“重新连接 / 接管”并接受提示，旧端会被断开。CLI 尚不支持再次附着，因此不提供 CLI runtime 的接管恢复。

| 情况                    | 当前行为                                         |
| ----------------------- | ------------------------------------------------ |
| 网页短暂断线            | 自动尝试重连，先同步状态再开放提交。             |
| Agent 网络断线          | 自动退避重连，运行中的 Codex 不立即退出。        |
| 客户端持续离线          | 默认保留 runtime 30 分钟，随后请求中断并关闭。   |
| 审批无人响应            | 默认等待 10 分钟，随后拒绝。                     |
| Agent 重启 / Codex 退出 | 原活动会话标记失败；当前没有旧线程恢复入口。     |
| 提交后结果不明          | 显示错误，不自动重新执行；检查原会话和文件状态。 |

网页事件默认保留 7 天，受每主机约 1 GiB 配额限制，可能提前清理已结束会话。同项目默认一次只允许一个活跃轮次，避免并发写入同一份文件。

## 8. 停用主机与管理凭据

```bash
./build/coc revoke --host build-server
```

撤销设备后，中转关闭该主机与客户端连接；Agent 收到撤销关闭码后停止本地会话并退出。撤销不会回滚已发生的修改，也不能保证所有外部进程退出，需要时在服务器检查。

需要恢复接入时重新登记为新设备。已撤销设备仍保留在主机列表中，当前登记数量上限为 5 台（含保留的撤销记录）。

## 9. 常见问题

| 问题                  | 处理方式                                                       |
| --------------------- | -------------------------------------------------------------- |
| 网站打不开            | 确认网站已经部署、域名和 HTTPS 正常；本机使用回环地址。        |
| 登录失败              | 使用中转所有者密钥，不是 Codex API Key；短期连续失败会被限流。 |
| 登记码失效            | 重新执行 `enroll`，已使用或超过 5 分钟的登记码不能复用。       |
| 主机离线              | 检查 Agent 进程、出站 WSS、设备凭据和服务器时间。              |
| 看不到项目            | 检查 Agent JSON 的项目路径、ID 和运行用户权限。                |
| 会话启动失败          | 检查 Codex 版本、服务端模型配置和最多 4 个活跃会话的限制。     |
| 控制权冲突            | 使用原控制端；网页可明确接管。                                 |
| CLI 重连被拒绝        | 当前版本不支持再次附着；先检查任务状态，再结束旧会话。         |
| 超大输出导致会话失败  | 当前单帧上限 256 KiB，尚无分片；缩小任务输出。                 |
| workerd 报 GLIBC 错误 | 参见容器方案，不要替换宿主系统 libc。                          |

报告问题时提供时间、主机/会话 ID、版本和错误码，勿提供登录密钥、设备令牌或模型凭据。

## 10. 数据与访问范围

首版面向个人可信操作者。能够控制会话的人可请求 Codex 在服务器执行操作；项目白名单不是不可信多用户隔离。

代码、Codex 凭据和历史保留在远程服务器。云端不持久化消息正文，但 Cloudflare 中转可见传输内容；当前不提供端到端加密。结束会话不会删除代码或历史。

完整目标与当前实现的差异见 [README](../README.md)、[需求文档](REQUIREMENTS.md) 和 [技术架构](ARCHITECTURE.md)。
