# 用户手册

## 管理列表同步 · 2026-10-27

批准、撤销设备、创建 / 撤销 API Key 和保存唤醒配置后，管理页会同步更新已授权设备、Key 和主机列表，不需要依赖通知到达才能看到本人操作的结果。“刷新状态”会等待这些管理数据读取完成再结束加载。其他客户端的变化仍通过通知更新，漏通知时可手动刷新；空闲不轮询。

## 旧版主机记录 · 2026-10-27

服务器唤醒配置和授权目标只列出当前协议的主机。早期版本遗留的主机可能仍保存在云端，但其旧凭证已不被新版接受，不再列入这些管理列表或接收版本通知；历史记录不自动删除。升级跨越旧认证协议时，需按当前流程重新为 Agent 申请授权。若“唤醒配置有主机、已授权设备没有”，先点击“刷新状态”，并按服务器标识核对；当前协议主机仍不一致时需进一步核对授权记录，不能只凭名称认定已授权。

## 通知开销优化 · 2026-10-27

管理员登录、退出和创建 API Key 不再触发所有主机的网页刷新；主机配置、授权和配对变化仅通知相关主机。管理员列表及本申请的配对通知继续更新，版本发布仍通知全部有效主机。申请到期仍撤销未领取授权；漏通知时继续使用“刷新状态”或重连恢复。此次修改无需变更客户端配置；实测基线见 [DO 用量分析](do-usage-2026-10-27.md)。

## 0.5.12：刷新、通知与未确认状态

Agent 空闲时不发送应用 / 协议心跳，也不因长期无消息断开；审批与版本变更通过通知触发读取，启动 / 明确重连可同步一次。`autoUpdate.intervalHours` 仍接受旧配置，但已废弃，不再调度下载；`enabled`、更新来源 / 完整性校验及忙碌时不安装保持有效。自动连接失败最多重试五次，之后等待显式恢复；Linux 可向 Agent 进程发送 `kill -USR1 PID`，其他平台可重启 Agent。网络静默丢弃连接时，A 不会主动发现，后续操作可能显示未确认。

CW 顶部及连接设置提供“刷新状态 / 刷新主机”，管理员视图也使用顶部按钮。首次进入和通知到达时读取快照；普通空闲不轮询。点击刷新显示加载状态并合并重复点击；需要 A 时发起只读 probe，成功显示最近确认时间，失败显示错误或未确认。正常连接下刷新保留草稿、历史和审批，不重复创建任务。管理列表由当前视图的通知刷新；切换回前台可进行一次恢复同步。

服务器的 `online` 只表示已登记的协商连接，`confirmed:false` / `reachability:unconfirmed` 不保证此刻可达；最近确认只代表该次实际回应。CW 选中离线且配置唤醒的 A 时请求一次唤醒，随后等待通知或手动刷新；连接设置中的“重试唤醒”可再次请求，仍受服务端一分钟去重限制，不每分钟重发。唤醒请求成功不代表硬件已上线。

CC 登录等待、异步结果等待和 TUI 交互在各自命令生命周期中共用每 10 秒一轮的刷新节奏，上一轮未完不叠加；事件可提前结束等待。唤醒等待保持 60 秒总期限；一次性命令只读取所需目标后退出，没有后台服务。CW 配对通过本申请的秘密绑定通知领取；A 初次配对也使用通知，已知网络失败只进行有限恢复。没有收到通知时可显式重连或重新登录，公开申请 ID 和配对码不能订阅或领取。

控制接口发送后返回 `202 {accepted,hostId,operationId}`，客户端订阅结果通知并读取 `/api/v1/hosts/HOST/operations/ID`，处理后 POST 同一路径释放临时回执。请求头 `X-CoC-Async: 1` 表明支持新协议，响应头 `X-CoC-Demand: 1` 确认 Relay 支持；新客户端拒绝缺少此标记的旧控制接口；旧控制客户端会收到 `UPGRADE_REQUIRED`。Agent / Relay hello 协商 `demand:1`，新 Agent 拒绝不支持的 Relay。建议先部署 Relay / 网页，再升级原生程序；旧 Agent 可继续协商原 protocol 1，但仍有旧周期流量，且不支持新的 probe，客户端会要求升级。已有凭证、SQLite、lease、请求 ID 和历史不清空。CLI 票据在已确认的 attach 预留期限内领取（最长约十五秒，以返回 expiresIn 为准）；过期重新获取，不使用已过期票据继续连接。

网页本地结果等待约 15 秒，原生 HTTP 总等待仍最多 30 秒；`RESULT_UNKNOWN` 不代表远端未执行。保留原 requestId，通过刷新、重连和原请求结果查询恢复，不换 ID 自动重做任务。Relay 临时关联 / 结果回执最多保留五分钟、每主机最多 64 个在途 / 256 个总回执；传输负载可能临时持久化，领取后可释放，到期删除，权威任务结果及完整历史仍在 Agent。通知不携带凭据，不做 ACK 超时重发或周期对账；漏通知后靠刷新 / 真实活动 / 明确重连恢复。

撤销成功时尝试立即关闭连接；通知丢失时允许空闲连接保留到下次活动，不再承诺固定时间关闭。发送、接收和事件转发前仍验证授权，缓存最长五秒；Registry 不可用时拒绝放行。空闲零周期通讯不代表平台固定费用、已有存储、真实业务、有限到期清理和故障恢复免费。详见 [计费优化方案](do-billing-optimization-2026-10-26.md) 与 [测试记录](TEST_REPORT.md)。

> 0.5.10 开发预览版。生产中转 R：**https://r.xlogic.cc**；本机开发地址：`http://127.0.0.1:8787`。下载：[原生程序和源码](https://r.xlogic.cc/downloads/)。

## 1. 组件与权限

| 简称     | 组件                                | 职责与凭证范围                                                 |
| -------- | ----------------------------------- | -------------------------------------------------------------- |
| R        | Cloudflare Worker / Durable Objects | 登录审批、授权校验、撤销、中转                                 |
| A        | `coc-agent`                         | 运行 Codex；审批指定本机的 CC / CW                             |
| CC       | `coc-client`                        | 一份凭证仅访问一个指定 A 的客户端功能                          |
| CW       | 网页 Codex 客户端                   | 一份浏览器凭证仅访问一个指定 A 的客户端功能                    |
| 管理身份 | 网页管理入口                        | 审批 A / CC / CW 登录、查看和撤销设备；不能直接操作 Codex 会话 |

只有两个本地程序，不再提供原来的 `coc`。A、CC、CW 使用相同的设备授权机制。每份授权独立，绑定角色和设备；CC / CW 额外绑定目标 A。不同角色的凭证不能互换。CC 控制 CLI 模式会话，CW 控制网页模式会话。

指定目标审批从 0.5.5 起提供，需要更新 Worker、网页及使用该功能的原生程序。

每次登录申请有效 5 分钟。批准后领取的设备凭证没有固定到期时间，直到 R 撤销。不要把配对码当作凭证；只有发起申请的程序或浏览器能够领取对应授权。审批方需核对申请方提供的配对码、设备名称、角色和留言；未指定目标的 CC / CW 由管理员选择服务器，避免批准陌生请求。

CC 在本地文件保存多份凭证；CW 为每个 A 保存独立的持久化 HttpOnly Cookie，可切换 A 及其会话。浏览器对 Cookie 有存储期限限制，网站在使用时续写；浏览器清理、隐私模式退出或长期未访问导致 Cookie 丢失时仍需重新申请。R 不会因设备离线、程序重启或关闭页面自动撤销授权。

原生 Agent / CLI 在等待配对批准时，HTTP 超时或断连会在原五分钟申请期限内重试同一轮询，不重新申请。新版 Relay 允许凭原轮询秘密重取同一批准结果，解决批准响应丢失；网页保持单次交付。拒绝、撤销和其他服务端错误立即停止。需同时升级 Relay 和原生程序；旧 Relay 已消费且丢失的结果无法恢复，须在管理网页核对并撤销未使用授权后重新登录。

### 实例显示名与管理员 Tab

Agent 与客户端均保存独立的 `displayName`。首次登录通过 `--name` 指定，未指定时默认使用本机主机名；后续登录复用已保存名称。名称去除首尾空白，长度为 1–100 个 UTF-16 单元，禁止控制字符。

```bash
coc-agent login --name '办公室服务器' --project /srv/projects/demo
coc-client login --name '我的笔记本' --message '申请开发访问'
# 已登录后修改名称，不重新签发凭证
coc-agent name '办公室服务器'
coc-client name '我的笔记本'
```

`name` 命令也可在登录前保存名称。Agent 的名称显示在主机列表、授权记录和连接日志；客户端名称显示在授权请求、已授权设备及 `status` 的 `clientDisplayName` 字段。客户端凭证条目的 `name` 仍表示目标服务器名称，用于既有 `--host` 选择；`displayName` 独立保存实例名称。客户端改名同步当前配置文件内全部授权；若某份授权已撤销或中继不可达，命令报错，可移除失效授权后重试。不同实例应使用不同 `--config`。

已运行的 Agent 改名后需重启，避免旧进程下次连接重新登记旧名称。Agent 每次连接登记配置中的名称，旧配置未设置时保留云端名称。改名接口与自动登记名称需要同步升级 Relay。

管理员登录后按“待授权请求、已授权设备、服务器唤醒配置、API Key 管理、管理会话”五个 Tab 操作。Tab 支持左右方向键与 Home / End；授权链接仍直接定位待授权请求。撤销其他管理会话位于“管理会话”。

### HTTP / SOCKS5 代理

两个原生程序均支持配置文件顶层 `proxy`；Agent 位于 `agent.json`，客户端位于版本 2 的 `credentials.json` 顶层。可在登录前配置：

```bash
coc-agent proxy 'http://127.0.0.1:7890'
coc-client proxy 'socks5://127.0.0.1:1080'
# 仅覆盖本次命令；login 会保存该值
coc-client hosts --proxy 'http://127.0.0.1:7890'
# 空字符串禁用
coc-client proxy ''
coc-agent proxy ''
```

优先级：`--proxy` 高于配置文件；未设置或空字符串为直连，不自动读取系统代理环境变量。`proxy` 命令持久保存配置，运行中的 Agent 需重启。支持 `http://host:port`（CONNECT）、`socks5://host:port`，`socks://` 与 `socks5h://` 为 SOCKS5 别名。端口必须显式指定；IPv6 使用 `[::1]:1080`。可选 `user:password@` 认证，特殊字符使用百分号编码。HTTP 使用 Basic，SOCKS5 使用用户名密码认证；密码仅写入私有本地配置，不输出代理 URL，不上传 Relay。应使用可信代理，代理认证本身不加密。

代理覆盖登录、状态、更新下载、业务 HTTP、Agent/客户端 WebSocket、历史流及 `connect` / `attach` 的远程 TUI。TUI 通过仅监听 `127.0.0.1` 随机端口、凭票据鉴权的本地 WebSocket 转接外部流量；TLS 校验在 coc-client 访问目标服务器时完成，不修改 Codex 子进程的代理环境。未启用代理的 TUI 地址始终显式包含 `:443` / `:80`，避免 Codex 的 `invalid remote address` 错误。遇到该错误时可用 `coc-client attach <Remote session 中的完整 ID>` 重连已有会话。

本机、局域网地址自动直连：IPv4 loopback、10/8、172.16/12、192.168/16、169.254/16、100.64/10、未指定地址，以及 IPv6 loopback、link-local、site-local、ULA 和映射的 IPv4 本地地址。域名先在本机解析；任一结果属于上述范围则对本次解析结果直连，包含 `localhost`。即使选择 `socks5h://`，也需要本地 DNS 完成绕过判断；仅公网目标交给代理。DNS、隧道和 TLS 均纳入 HTTP 总超时；代理失败不会回退公网直连。Codex app-server 的本机 WebSocket、私有 Unix socket 和 stdio 通道始终直连，不受此配置影响。

## 2. 安装与前置条件

当前原生发行包支持 Linux x86_64，提供 Ubuntu 20.04、Debian 12 动态链接包，以及基于 musl 的全静态包 `coc-<版本>-linux-x86_64-musl.tar.gz`（新增包是否已发布以下载清单为准）。选择匹配的发行版或 musl 通用包，下载并核对 `SHA256SUMS`，解压后安装：

```bash
mkdir -p "$HOME/.local/bin"
install -m 0755 coc-agent coc-client "$HOME/.local/bin/"
export PATH="$HOME/.local/bin:$PATH"
```

只运行服务器时只需安装 `coc-agent`；用户电脑只需安装 `coc-client`。运行原生程序不需要 Node.js。动态包需要对应版本的 OpenSSL、Boost.System、SQLite3、libstdc++ 和 CA 证书；用 `ldd coc-agent` / `ldd coc-client` 检查动态库。musl 包已静态链接 libc、C++ 运行库及第三方库，可在 Alpine 或 glibc Linux 上运行，无需安装 musl 或上述动态库；仍需系统 CA 证书以验证 TLS。Codex 是单独安装的外部程序，其运行依赖不包含在此静态包中。

A 必须安装并配置 **Codex 0.164.0**，以运行 Agent 的系统用户确认 `codex` 可以正常使用。使用 CC 的电脑同样需要 Codex 0.164.0 来运行原生 TUI；CW 用户不需要安装 Codex。模型凭据、代码和命令执行留在 A 上；模型 API Key 不用于 R 登录。

从源码开发时：

```bash
npm ci
npm run build:native
npm run setup:local
npm run dev
```

开发需要 Node.js ≥22.17、C++17、CMake ≥3.16、Boost.System ≥1.71、OpenSSL、SQLite3、nlohmann/json ≥3.7。GitHub Actions 通过缓存加速构建，仍执行来源校验与完整测试。本机源码构建也可安装 ccache，并先执行 `cmake -S . -B build -DCMAKE_CXX_COMPILER_LAUNCHER=ccache` 启用编译缓存；后续继续使用上述构建命令。Ubuntu 20.04 的 workerd 容器方案见 [开发说明](DEVELOPMENT.md)。以下示例的 R 地址在本机体验时替换为 `http://127.0.0.1:8787`。

### Windows x64

原生源码新增 Windows 10/11 x64、Windows Server 2019+ 的 `coc-agent.exe` / `coc-client.exe` 构建；下载是否已发布以下载清单为准。Windows ZIP 使用静态第三方库和 MSVC 运行库，无需安装 Node.js 或单独复制 DLL。下载 `coc-<版本>-windows-x64.zip` 后用 `Get-FileHash -Algorithm SHA256` 核对 `SHA256SUMS`，完整解压到用户可写目录，并把该目录加入 PATH。

必须使用 Codex 0.164.0 的原生 `codex.exe`。将它加入 PATH，或设置 `$env:COC_CODEX_PATH = 'C:\Tools\Codex\codex.exe'`；Agent 也可在配置中设置 `codexPath`。npm 的 `codex.cmd` 不能直接作为子进程启动路径；使用 npm 安装 Codex 时，需指向其实际原生可执行文件。先运行 `& $env:COC_CODEX_PATH --version` 确认版本；模型凭据和 Codex Windows 沙箱需按 Codex 本身要求配置。CC 的远程 TUI 使用 Windows Terminal / PowerShell。

```powershell
.\coc-agent.exe login --relay https://r.xlogic.cc --project 'C:\Projects\demo'
.\coc-agent.exe run
# 在另一台客户端电脑申请独立 CC 授权
.\coc-client.exe login --relay https://r.xlogic.cc --message '申请 Windows 开发访问'
.\coc-client.exe hosts
```

默认配置在 `%LOCALAPPDATA%\coc-agent\agent.json`、`%LOCALAPPDATA%\coc-client\credentials.json`；历史缓存在 `%LOCALAPPDATA%\coc-client\history`。`--config`、`COC_AGENT_CONFIG`、`COC_CREDENTIALS` 等显式路径仍可覆盖。凭据与 Agent 状态使用当前用户及 SYSTEM 的受保护 ACL；不要放到 FAT/exFAT 或共享给不可信用户的目录。JSON 中项目路径用 `C:/Projects/demo` 或转义反斜杠，配置文件保持 UTF-8。

Windows 支持授权、审批、Agent 会话、CC 历史和工作区文件传输；CW 聊天下载同时识别项目内的 Windows 盘符和反斜杠路径。文件接口使用 `/` 分隔项目相对路径，拒绝盘符、UNC、设备名、备用数据流、符号链接及 junction；项目必须位于本地磁盘。上传期间目录和目标可能因文件共享锁而无法移动或写入。TLS 同时加载 OpenSSL 默认信任路径和 Windows ROOT 证书库，保留主机名校验。

Windows 当前使用手动整包升级：结束会话、停止 Agent、备份配置与状态，校验新版 ZIP 后替换两个程序，再重新运行；不改变凭据或数据库。Windows 不执行自动替换，`update` 返回手动升级提示。后台常驻可由任务计划程序以同一普通用户身份运行 `coc-agent.exe run`；当前不提供 Windows Service 注册命令。源码构建和测试见 [开发说明](DEVELOPMENT.md)。

`coc-agent login` 保存 `agent.json` 时会写出全部默认选项，包括 `wakeUrl`、`codexPath`、`codexArgs`、`sandbox`、`externalSessions` 的四个字段及 `autoUpdate` 的 enabled / intervalHours / platform。默认外部入队和审批均关闭；审批地址和令牌文件为空，平台为空表示自动匹配；自动更新 Linux 默认开启、Windows 默认关闭。使用已有无令牌配置登录时，补齐缺失项并保留自定义值；不会在 Agent 运行时重写配置。完整字段示例见 `examples/agent.example.json`。

### 原生程序自动更新

以下自动更新机制适用于 Linux；Windows 按上一节手动整包升级。

从 0.5.2 起默认启用自动更新。0.5.12 起 Agent 在启动、明确重连或收到版本发布通知时检查配置中 `relayUrl` 的 `/downloads/`，稳定空闲时不周期检查；下载和候选检查在后台进行，等所有运行会话结束且没有历史读取后才关闭连接、释放数据库锁并原地重启，沿用原启动参数。空闲检查最多约 30 秒一次；保持附着但未执行任务的会话仍算运行会话，须结束会话后才切换。CLI 在成功的业务命令结束（TUI 退出）后检查，安装后下一次启动生效，不会在 TUI 运行中替换进程。help、version、doctor、logout 和离线历史读取不触发自动检查。

在 Agent 的 `agent.json` 或 CLI 的 `credentials.json` 顶层加入以下配置即可禁止自动下载和安装，既有凭据字段保持原样：

```json
{ "autoUpdate": false }
```

也可设置 `{"autoUpdate":{"enabled":true}}`。旧 `intervalHours` 字段仍按 1–168 小时校验以兼容已有配置，但 0.5.12 起不再调度周期下载或失败重试。Agent 的本地维护读取配置并处理已准备更新，CLI 在下次命令读取；不会因此新增云端查询。关闭后不发起新检查并丢弃待安装结果，已经发起的下载可能完成。CLI 首次登录前若要禁用，可预建 `{"version":2,"entries":[],"selected":"","autoUpdate":false}`；没有现有 Agent 配置时，首次登录后、运行前设置。

自动匹配 Linux x86_64 / Ubuntu 20.04 或 Debian 12；兼容衍生系统需明确设置 `autoUpdate.platform` 为 `ubuntu20.04` 或 `debian12`，不会猜测 ABI。musl 静态版默认始终选择 `musl` 更新包，不按宿主发行版切换到动态包；也可显式设置 `autoUpdate.platform` 为 `musl`。检查来自所连接中继，CLI 优先 `--relay`，否则选中主机的中继；无选中主机时使用默认地址。不向下载接口发送设备凭据，不跟随重定向，不降级或安装预发行版本，要求协议主版本一致。开发脏构建不自动更新。

程序和安装目录必须归运行用户所有、目录可写且没有组/其他用户写权限；拒绝 set-ID 程序。建议安装到该用户的 `~/.local/bin`，并让 systemd 使用相同路径。root 所有的 `/usr/local/bin` 安装不会让普通用户自动提权更新，需管理员手动安装，或改为用户目录。更新依赖系统 `/bin/tar`；无需 Node.js，不更新 Codex、系统动态库、配置、凭据或数据库。

每次安装验证归档 SHA256、候选程序 `--version` 的版本/提交/源码摘要/目标/协议及干净身份，保留权限并原子替换当前程序；旧文件保存为同目录 `<程序名>.previous`，仅保留上一版。校验失败、权限不足或网络失败会向 stderr 输出更新错误，自动检查不使当前业务命令失败。此校验依赖中继 HTTPS 和下载服务可信，不是独立发布签名。管理员仍须检查新发行版兼容性。

可以显式执行以下命令立即检查（不受自动开关限制），无需重新登录：

```bash
coc-client update --config ~/.config/coc-client/credentials.json
coc-agent update --config ~/.config/coc-agent/agent.json
```

运行中的 Agent 手动更新后须自行重启服务；自动更新会自行重启。需要回退时先停 Agent 或退出 CLI，将 `.previous` 文件替换回原程序后重新启动，并配置 `autoUpdate: false` 防止再次升级。程序回退不回退数据库或工作区；跨版本数据兼容性与备份要求见 [发布说明](RELEASE.md)。0.5.1 及更早程序没有自动更新功能，首次升级仍须手动安装当前发行版。

## 3. 管理网页

打开 R 网站，进入“功能菜单”，点击底部“切换到管理员模式”，在管理员登录表单输入所有者密钥。管理员模式提供设备授权、服务器唤醒配置、API Key 和登录后的“退出管理”；未登录时需先认证。设备申请的授权链接直接进入此模式。本地开发密钥在 `.local/owner-secret`；生产使用独立密钥，不能分发给客户端。管理员会话有效 8 小时，与长期设备凭证分开。

待授权请求、已授权设备、服务器唤醒配置和 API Key 列表按表格展示，一行对应一条记录，操作按钮位于对应行。手机窄屏可在表格区域左右滑动查看全部列；键盘用户可聚焦该区域后按左右方向键滚动。请求 / 授权标识可在名称列展开查看；空列表显示对应提示。

“设备授权管理”展示待授权请求的设备类型、名称、配对码及有效期；CC / CW 请求还展示申请留言。核对后，管理员为未指定目标的 CC / CW 请求明确选择一台未停用的服务器，再点击批准；未选择时不能批准，没有服务器时需先授权服务器 Agent。可选择已授权但暂时离线的服务器，连接和创建会话仍需等待 Agent 在线。也可直接拒绝申请，无需选择服务器。请求页面会自动刷新。已授权设备列表可单独撤销凭证，不显示秘密凭证。API Key 登录仍校验创建 Key 时绑定的目标。

CC / CW 可以主动指定目标 A，对应 Agent 或管理员均可批准；管理页锁定该目标，不能改绑。未指定目标的申请继续仅由管理员选择服务器，客户端无需事先获取 A 标识。

管理员登录本身不授予 A 访问权；要在同一浏览器使用 Codex，在功能菜单底部点击“切换到CW模式”，另外申请 CW 授权。切换模式不会退出管理员登录或断开当前 CW 会话。

### API_KEY 登录（与配对审批并行）

管理员可在“API Key 管理”输入名称并选择使用程序：`coc-agent` 或 `coc-client`。创建 CC Key 必须同时选择目标 A，创建后不能修改角色或目标。A Key 首次使用时创建并绑定自己的 A，之后使用同一个 Key 总是返回该 A，不会重新创建或改绑。未使用的 A Key 不占主机配额。

完整 Key 仅在生成后显示一次；请立即复制保存，列表只显示名称、角色、绑定 A 和创建时间。API_KEY 本身就是访问凭证，不用于换取另一份长期密钥。持有 Key 即可访问其限定功能，不绑定某台电脑或安装实例。它与配对审批得到的独立凭证并行，均长期有效直到 R 撤销。

登录时增加 `--api-key`，程序会隐藏终端输入；也支持通过标准输入或 `COC_API_KEY` 环境变量提供。不要将 Key 作为命令行参数，以免留在命令历史或进程列表中。

```bash
# 按提示输入 A Key；首次仍需配置项目
coc-agent login --api-key --relay https://r.xlogic.cc --project /srv/projects/my-project
# 输入 CC Key；--host 必须与管理员创建 Key 时选定的 A 一致
coc-client login --api-key --relay https://r.xlogic.cc --host <A-ID>
```

登录后原样将 API_KEY 保存到原有 `0600` 配置文件，后续 `run`、`status`、`connect` 等命令无需再次输入。无人值守时可由秘密管理服务注入 `COC_API_KEY`，登录完成后移除环境变量。共享 Key 的多个程序共用同一身份，撤销会影响所有持有者；需要独立撤销时请分别生成 Key。

管理员在网页撤销 Key 后，已有连接立即关闭；撤销已绑定的 A Key 会停用对应 A，并使其全部 CC / CW 授权失效。已授权设备列表中撤销同一身份效果一致。未使用的 A Key 也可撤销。本地 `logout` 仅删除本地副本，不撤销 R 中的 Key。原有配对审批登录方法继续支持，0.3.0 设备凭证无需重新登录。

## 4. 运行 A

在服务器上申请自己的登录，同时创建项目配置：

```bash
coc-agent login --relay https://r.xlogic.cc --name build-server \
  --config ~/.config/coc-agent/agent.json \
  --project /srv/projects/my-project --project-id my-project
```

终端显示管理网页地址和配对码。将请求交给管理员，在网页核对并批准。程序自动领取 A 专用凭证，写入权限为 `0600` 的配置文件，并输出 A 标识。无需安装 CC 或生成登记码。

```bash
coc-agent status --config ~/.config/coc-agent/agent.json
coc-agent run --config ~/.config/coc-agent/agent.json
```

出现 `Agent connected` 后即可供授权客户端使用。默认配置路径为 `~/.config/coc-agent/agent.json`，可通过 `--config` 或 `COC_AGENT_CONFIG` 指定。已有非空凭证时拒绝再次登录，避免意外覆盖身份。首次登录必须提供 `--project`。

配置示例见 [agent.example.json](../examples/agent.example.json)。可在 `projects` 数组增加项目，每项包含唯一的 `id`、显示名 `name` 和真实绝对路径 `path`；客户端只能选择已配置项目，不能指定任意路径。`codexPath`、`codexArgs` 和 `sandbox` 由服务器配置，客户端不能修改。重启 Agent 后配置生效。

每个 `dataDir` 只能运行一个 Agent。先前台确认运行正常，再参考 [systemd 模板](../examples/coc-agent.service) 设置实际运行用户、HOME、Codex PATH 和配置路径。A 只建立出站 WSS，不要将 Codex app-server 直接暴露到公网。

### 离线自动唤醒（0.5.6 起）

每台 Agent 可关联一个唤醒 URL。URL 应由独立于休眠服务器的服务提供，收到 HTTP GET 后负责开机或启动 Agent；本项目只访问该 URL，不直接发送局域网唤醒包。该地址必须能从 Cloudflare 中继访问。

管理员在“设备授权管理 → 服务器唤醒配置”为服务器填写 URL 并保存，服务器离线时也能配置。管理员设置优先于 Agent 设置；保存空值可禁用该主机唤醒，点击“使用 Agent 配置”恢复使用 Agent 提供的地址。

Agent 持有者也可在登录后执行，无需运行 Agent 服务：

```bash
coc-agent wake-url 'https://wake.example/start?key=YOUR_SECRET' --config ~/.config/coc-agent/agent.json
# 清除 Agent 提供的地址；管理员覆盖配置仍然有效
coc-agent wake-url '' --config ~/.config/coc-agent/agent.json
```

命令立即更新云端，并保存本地 `wakeUrl`；运行中的 Agent 需重启以重读本地配置。也可直接编辑配置文件的 `wakeUrl`，重启后随连接注册；未配置该字段的旧 Agent 不清除云端地址。URL 可能包含访问密钥，注意命令历史，并优先通过权限为 `0600` 的配置文件设置。

已授权 CW 选中离线主机时请求一次唤醒，通过通知或手动刷新检查上线状态；上线后重新加载项目和会话。需要再次唤醒时使用连接设置中的“重试唤醒”，仍受服务端一分钟限流，不设置后台状态轮询或唤醒重发。CC 的 `projects / sessions / connect / attach / stop / request / history` 访问若发现主机离线，会请求唤醒并等待最多 60 秒恢复；明确返回 `HOST_OFFLINE` 的 HTTP 操作恢复后只重试一次，保持请求标识。`status / hosts` 发现已配置的离线主机时也触发唤醒并返回结果，无需等待上线。`history --offline true` 只读本地缓存。

中继通过已授权客户端的 `POST /api/v1/hosts/:id/wake` 代为访问已登记地址；客户端不能指定其他 URL。URL、查询参数和唤醒服务响应正文不下发给 CW / CC；普通主机列表仅返回 `wakeConfigured`。管理员登录本身不能调用客户端唤醒接口。Agent 使用 `POST /api/v1/agent/wake-url`，管理员使用 `POST /api/v1/admin/hosts/:id/wake-url` 配置，JSON 为 `{"wakeUrl":"..."}`；管理员传 `null` 恢复 Agent 配置，传空字符串禁用。

唤醒 URL 最长 2048 字符，要求 HTTPS、无 URL 用户名密码和片段；HTTP 仅允许 `localhost / 127.0.0.1 / [::1]` 本地开发。请求保留 TLS 验证，不携带中继凭证或浏览器 Cookie，不跟随重定向，10 秒超时，只有 2xx 视为成功。每主机一分钟最多访问一次，多个 CW / CC 共用持久化限流，失败也限流；在线时不访问。成功仅表示唤醒服务接受请求，不保证主机一定上线；超时、未配置或唤醒失败会显示错误，可稍后重试。需要更新 Worker、网页及相关原生程序；没有登记 URL 的主机保持原有行为。

### 批准指定到本机的客户端（0.5.5 起）

将 `coc-agent status` 返回的主机 `id`（也就是配置中的 `hostId`）交给申请方。CC 在配对登录时传 `--host A_ID`，CW 在申请表填写“目标服务器 ID（选填）”。持有对应 Agent 配置的人可以查看并明确处理这些申请，无需管理员密钥：

```bash
coc-agent requests --config ~/.config/coc-agent/agent.json
coc-agent approve REQUEST_ID --config ~/.config/coc-agent/agent.json
coc-agent reject REQUEST_ID --config ~/.config/coc-agent/agent.json
```

执行 `coc-agent run` 时会立即在后台检查待审批申请，运行期间收到申请变化通知时检查一次。发现明确指定本机的新 CC / CW 申请，会向终端标准错误输出请求 ID、配对码、角色、名称、留言、到期时间，以及带当前配置路径的批准／拒绝命令。核对后在另一个终端执行提示命令即可，无需停止 Agent；systemd 运行时在服务日志中查看提示。

同一申请在本次运行中只提示一次，重启后仍待处理的申请会再次提示；需要重看可随时执行 `coc-agent requests`。检查不自动批准，也不等待终端输入。网络检查使用独立后台线程，单次超时 5 秒，不阻塞会话或连接处理；中继暂时不可用或旧中继不支持时输出失败提示，下一次真实通知、重连或显式 requests 命令可重试，连续失败不重复刷屏。

`requests` 返回目标为本机、尚未处理且未过期的 CC / CW 申请，包含请求 ID、配对码、角色、名称、留言和到期时间。先与申请方核对，再把请求 ID（不是配对码）传给 `approve` 或 `reject`。不会自动批准；申请仍在 5 分钟后过期。批准后凭证只交付给原申请程序或浏览器，直到管理员撤销。

这些命令使用配置中的中继地址和 Agent 凭证；支持 `COC_AGENT_CONFIG`，可在 Agent 服务运行或停止时执行，不占用运行目录锁。已绑定的 Agent API Key 也可使用；凭证撤销或主机停用后不能审批。Agent 看不到也不能批准其他 A、未指定目标的客户端或新 Agent 申请；不能修改申请的目标。管理员与 Agent 同时处理时仅一次成功。

## 5. 使用 CC

使用 0.5.3 或更新版 CC，并刷新管理员网页。填写设备名称和留言申请访问，无需事先获取服务器标识：

```bash
coc-client login --relay https://r.xlogic.cc --name my-laptop --message "我是项目维护者，请授权开发服务器"
```

`--message` 选填，最多 1000 字符，可说明身份、期望服务器和用途。终端显示授权网页地址和配对码；管理员查看留言、选择服务器后批准，CC 自动登录并保存管理员选定的目标。未传 `--host` 时由管理员选择目标；`--host` 也用于已授权服务器切换、其他业务命令和 API Key 登录。再次为另一个 A 执行登录会保留原凭证。同一个 R / A 在本地保存一份当前凭证，重新登录会替换本地记录，R 中的旧授权仍需管理员单独撤销。

已知 A 标识时可明确指定，由该 Agent 或管理员批准，目标不能改绑：

```bash
coc-client login --relay https://r.xlogic.cc --host A_ID --message "请目标服务器批准"
```

新版 CC / CW 会核对中继返回的目标；旧中继不支持时明确报错，不降级为管理员任意分配。旧版客户端传入的旧 `hostId` 字段仍不决定目标，仍须管理员选择。需要此功能时请升级客户端和中继。

```bash
coc-client hosts
coc-client use --host A_ID
coc-client status
coc-client projects
coc-client connect --project my-project
coc-client sessions
coc-client stop A_ID~SESSION_ID
```

`hosts` 仅查询本地已授权的 A，各 A 使用自己的凭证；失效授权单独显示错误，不影响其他 A。登录成功后默认选中新 A；`use` 持久保存默认选择，也可在每条命令传 `--host A_ID`。同名主机或跨 R 选择不明确时，使用 A 标识并追加 `--relay`。

`connect` 创建 CLI 会话并启动本地 Codex TUI。代码和命令运行在远程 A 的项目中。当前尚不支持重新附着已有 CLI runtime；`attach` 会返回明确的限制错误，先检查原任务状态，不要盲目重发。

默认凭证文件为 `~/.config/coc-client/credentials.json`，权限 `0600`，可通过 `--config` 或 `COC_CREDENTIALS` 指定。不要复制到其他设备或提交 Git。

## 6. 使用 CW

1. 打开 R 网站，在“连接远程服务器”填写设备名称和“给管理员留言”，点击“申请登录”。可留空服务器标识；0.5.5 起支持在“目标服务器 ID（选填）”指定 A，交给对应 Agent 或管理员批准。留言选填，最多 1000 字符，可说明身份、期望的服务器和用途，请勿填写密码等秘密。
2. 将页面上的配对码和请求信息交给审批方；指定目标时，对应 Agent 可用上述命令批准，管理员也可批准同一目标。未指定目标时，管理员在“设备授权管理”核对留言并选择服务器后批准。原页面自动完成登录并选中该服务器。
3. 从顶部“历史”或“功能菜单 → 会话记录”打开会话面板，在顶部“连接设置”选择在线 A 和项目；点击“创建网页会话”开始。以后可通过菜单中的“新建对话”开始，或打开“会话记录”恢复本地历史。
4. 聊天区区分你的消息和 Codex 回复，支持 Markdown 标题、列表、表格、代码块和链接；工具输出、计划、代码差异与状态默认折叠，点击展开。遇到命令或文件审批时检查详情并明确允许或拒绝。
5. 执行中在输入框旁点击“停止本轮”；通过“功能菜单 → 会话详情”查看连接状态、项目和会话 ID，或执行结束会话、重新连接 / 接管。

顶部“功能菜单”默认进入 CW 模式：有 CW 授权时提供会话记录、新建对话、工作区文件、会话详情及 CW 对话；未登录时提供 CW 对话与登录授权。管理员模式仅展示设备授权、API Key 和登录后的退出管理，管理员登录表单也只在该模式出现。两种模式通过菜单底部的切换按钮互换，切换后菜单保留打开，短视口中功能列表独立滚动、切换按钮保持可见。切换保留当前 CW 会话连接和草稿；刷新默认回到 CW 模式，设备授权链接直接进入管理员模式。切换只改变界面，不授予管理或设备权限。选择功能、点击外部或按 Escape 会关闭菜单。主机 / 项目选择、刷新主机、新建会话、添加 A 授权和移除本地授权位于“会话记录”面板顶部的“连接设置”，下方展示会话列表；管理员登录与退出通过管理员模式操作。

在“功能菜单”底部的“语言 / Language”选择“中文”或“English”，即可切换 CW 和管理员界面，默认中文。选择保存在当前浏览器，刷新后保留，同源标签页同步；浏览器禁止本地存储时仍可在当前页面切换。切换即时生效，保留当前会话连接、草稿与审批状态。页面标题、按钮、无障碍标签和日期格式随语言更新；对话原文、用户填写的名称、命令、路径与服务器返回的原始错误详情不自动翻译。

聊天输入使用 Enter 发送，Shift + Enter 换行；中文输入法确认候选时不会发送。执行中禁止重复发送，可停止本轮。消息自动跟随新输出，向上查看历史后暂停跟随，回到底部恢复。聊天区在桌面和手机均占满可用窗口，消息独立滚动、输入框保持可见；聊天时不显示主机 / 项目选择、会话列表、状态详情、快捷键说明或页脚。菜单中的“会话记录”和“会话详情”按需打开弹窗，选择会话后自动关闭；也可用“关闭”、Escape 或点击遮罩返回聊天。审批、执行中断和连接异常仍直接显示，防止遗漏必要操作。

向上滚动接近消息顶部时会加载更早内容；滚动条已在顶部时，继续向上滚动滚轮也会触发加载，读取失败后可用同样方式重试。加载期间不重复请求，历史全部读完后停止加载；也可点击“加载更早内容”。

聊天消息中的文件路径可直接单击下载，包括正文、行内代码、代码块、展开的工具输出及 Markdown 文件链接。相对路径按当前会话项目根目录解析，项目内绝对路径和 `file:///` 路径也可下载；`文件:行号:列号`、`文件#L行号` 会自动去除定位后缀。含空格的路径请使用 Markdown 链接（例如 `[报告](<docs/my report.pdf>)`）。普通网页链接仍在新标签打开，项目外路径不提供下载。单击后显示下载状态，成功时交给浏览器保存；不存在、目录、符号链接、超限或权限错误会显示失败原因，可再次单击重试。沿用 CW 文件接口鉴权及 20 MiB 上限，不需要模型执行下载命令。

通过“功能菜单 → 工作区文件”浏览当前主机所选项目的目录。点击目录进入，或用“上级目录”返回；普通文件可下载到浏览器。上传时先选择本地文件，可修改“保存为”的相对路径；父目录须已存在。默认禁止覆盖，确需替换时勾选“覆盖已有文件”并确认。单文件上限 20 MiB，支持二进制文件和空文件；目录列表每页 100 项，点击“加载更多文件”继续。暂不支持上传整个目录、创建目录或打包下载目录。

文件操作使用已授权 CW 凭证和 Agent 配置的项目根目录，不依赖活动对话或模型。只读 Agent 允许浏览和下载，禁止上传；路径不能越出项目，也不跟随符号链接。上传先写临时文件，全部完成后才发布，覆盖前重新核对目标是否变化；下载期间文件变化会报错，应重新下载。点击“取消传输”或关闭面板会中止当前传输，已完成的文件保留；断网或 Agent 强制退出时结果可能不明，先刷新目录检查。未完成上传会在 10 分钟无操作后清理；强制终止 Agent 遗留的 `.coc-upload-*` 临时文件需停机后人工清理。浏览和下载会显示项目中运行用户可读的普通文件（含隐藏文件），应只授权可信设备，并谨慎选择包含凭据的项目。此功能需要同时更新网页、Worker 和原生 Agent。

会话列表读取 A 运行用户的同一 Codex home，按更新时间展示当前项目的非归档交互会话，与该用户本地 Codex 共用历史；可搜索已加载的标题 / 摘要并“加载更多”。其他项目、其他系统用户、其他 Codex home 和归档线程不会混入。网页选择已有活动 CW 会话时重新附着；关闭 / 失败或原生 Codex 历史线程会创建新 CW runtime，恢复原 threadId 及对话内容，并强制使用 A 的项目目录、sandbox 和用户审批策略。如果线程正在其他终端或 IDE 中运行，遇到 active writer 锁会自动切换为外部会话：只读同步已有消息，通过队列向原客户端发送后续输入。无需先结束原客户端。

### 操作外部 Codex 会话（0.5.7）

Agent 必须与原客户端使用同一系统用户、同一 `CODEX_HOME`，项目目录必须匹配。CW 在历史记录中选择线程；正常恢复只有在明确的 active writer 错误时降级为外部观察。连接、约两秒一次刷新与历史分页使用只读 API，不获取 writer 锁。显示的是 Codex 已落盘的消息，可能晚于原终端的实时输出；原客户端尚未保存的内容无法读取。兼容 Codex 0.164.0 的 paginated 与 legacy 历史；单个本地 RPC 仍受原有帧大小限制，超限会提示错误。

默认仅可浏览。需要远程入队时，在 Agent 配置中明确开启并重启 Agent：

```json
{
  "sandbox": "workspace-write",
  "externalSessions": { "allowQueue": true }
}
```

只读 Agent 即使开启该开关也不能入队。队列输入由原客户端消费并执行，沿用原客户端自身的 sandbox、网络和审批设置；开启共享服务审批接入后，可在 CC / CW 提交审批决定。Agent 的策略不能覆盖外部 writer。确认原客户端设置符合预期后再开启。原客户端版本或状态不支持队列时会返回错误；“已加入队列”不表示已执行，也不保证原客户端会立即消费。

外部会话执行中仍可点“加入队列”。消息按稳定 item ID 更新，同一条增长中的回复不会重复追加全文；大内容继续分块读取。停止此连接仅停止 Agent 观察进程，原客户端继续运行，已入队消息保留；不支持中断或接管外部 writer；远程审批需按下一节接入原共享服务。网络故障时保持原 request ID 查询结果，不能将未确认请求换新 ID 自动重发。

CC 可显式连接为观察模式，无需启动本地 TUI：

```bash
coc-client threads --project PROJECT_ID --host A_ID
coc-client observe THREAD_ID --project PROJECT_ID --host A_ID
coc-client history SESSION_ID --host A_ID
coc-client queue SESSION_ID --host A_ID --message "下一步检查测试" --request-id stable-request-id
coc-client request stable-request-id --session SESSION_ID --host A_ID
coc-client stop SESSION_ID --host A_ID
```

外部输出按当前轮已观察内容的起点持续回读，避免较早消息在新增超过 16 项后漏掉补全内容；新轮出现后才推进起点。每次本地 RPC 仍只读取一个分页条目，不缓存整轮历史。输出仍取决于原 Codex 的落盘时机，不能把历史观察当作原服务的实时通知流。

`observe` 返回新的 CLI 观察会话 ID；`history` 读取最新已同步内容，支持已有分页、分块及离线缓存。`queue` 输出请求 ID；同 ID 同内容返回既有结果，不重复入队，同 ID 不同内容被拒绝。若入队应答丢失，同 ID 重试只查询 pending queue 来确认；已被原客户端消费时保留 `RESULT_UNKNOWN`，请核对原客户端历史。CC / CW 会话及请求保持角色隔离。

### 无人值守外部会话的远程审批

外部 session 的审批必须连接**原来的同一个 app-server**，不能从历史或消息队列恢复。已在共享 app-server 中运行的终端 / IDE 会话，可以在不结束任务的情况下接入；只有独占 stdio、未开放服务连接的现有进程无法热插拔审批转发。此时页面明确显示“审批在原客户端”，不能把消息入队视为已经解决审批。无人值守前请先完成一次远程审批验证。

配置默认关闭；需 workspace-write Agent 明确开启：

```json
{
  "sandbox": "workspace-write",
  "externalSessions": {
    "allowQueue": true,
    "allowApprovals": true,
    "approvalEndpoint": "",
    "approvalTokenFile": ""
  }
}
```

Linux 不填 endpoint 时，连接 `$CODEX_HOME/app-server-control/app-server-control.sock`；未设置 CODEX_HOME 时使用 `~/.codex`。也可显式填写 `unix:///绝对路径/app-server-control.sock`。socket 必须归 Agent 用户所有，且禁止其他用户访问；仅接入已有服务，不启动或停止原服务，不覆盖其 sandbox 或审批策略。Agent 验证 thread 已在该服务加载且项目匹配后订阅；不匹配时不会冷恢复该线程。

Windows 使用显式的本机 WebSocket endpoint；Linux 也支持此方式。例如先在 Codex 电脑启动共享服务，再由本地终端连接该服务：

```bash
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
```

上述命令须在运行原生 Codex 的同一台 Windows 主机上执行，不能用另一个 WSL 实例中的服务代替。Windows 不能使用空 endpoint 或 Unix socket；仅开启 `allowApprovals` 不会自动给既有原生 Codex 增加 WebSocket 监听。若现有线程未在该 WebSocket 服务中加载，需先在原客户端妥善结束本轮，再规划切换；仅启动另一个 app-server 并改地址不能接入旧服务中的审批。

然后把 Agent 的 `externalSessions.approvalEndpoint` 设为 `ws://127.0.0.1:4500`。只接受本机 loopback 地址或私有 Unix socket；不会自动暴露公网端口。共享服务启用 capability-token 鉴权时，给服务配置 `--ws-auth capability-token --ws-token-file PATH`，Agent 的 `approvalTokenFile` 填同一令牌文件路径，本地终端用 `--remote-auth-token-env ENV_NAME` 提供令牌。令牌不发送给 Relay / CC / CW。

页面显示“可远程审批”才代表已接入。已有待审批会在订阅时重放，新请求实时转发；原客户端或另一连接处理后会清除远程待办。CW 可处理命令执行、文件变更和本轮额外权限请求：命令 / 文件只批准本次，额外权限只授予请求列出的 network / fileSystem 权限且限本轮，不授予永久或整会话权限。文件审批同步原服务可提供的变更详情；较大详情通过对话中的工具记录分块展开，请核对后再决定。MCP 表单、工具输入及其他不兼容交互会显示需要原客户端处理；生物验证等绑定原设备的请求不转移。不会自动放行或把不支持的请求自动拒绝。

CC 使用观察会话 ID 处理待办：

```bash
coc-client approvals SESSION_ID --host A_ID
coc-client approve SESSION_ID --host A_ID --approval-id APPROVAL_ID --request-id stable-approval-request
coc-client reject SESSION_ID --host A_ID --approval-id APPROVAL_ID --request-id another-stable-request
coc-client request stable-approval-request --session SESSION_ID --host A_ID
```

`approval-submitted` 仅表示决定已提交，最终以原 app-server 的解决通知及执行结果为准；其他客户端也可能先处理。相同 request ID 不重复发送；同一审批已提交后，不允许换 ID 再发相反决定。断线结果不明时先查询，不自动重发。审批连接每 15 秒尝试恢复，并重新获取仍待处理的请求。断开观察只关闭 Agent 自己的连接，不自动拒绝外部审批，不中断原任务，也不关闭共享服务。既有普通 Agent 会话的审批超时规则不变。

在“会话记录”顶部的“连接设置”点击“添加 A 授权”可再次留言申请，由管理员选择另一个 A；0.5.5 起也可填写目标 A，由该 Agent 或管理员批准。已有授权保留；下拉列表仅展示本浏览器已授权的 A。刷新或重新打开浏览器后，可选择原 A 与网页会话，恢复保留的历史和当前状态。不同标签页可以选择不同 A，R 根据请求目标选择对应 Cookie，不依赖全局当前凭证。

秘密凭证不放入 URL 或 JavaScript 本地存储；HttpOnly Cookie 对页面脚本不可读。CW 不能通过改写 A 标识访问其他主机，也没有审批设备登录的权限。

回复按持久事件序号排序、去重后拼接。网页只支持文本输入和命令 / 文件审批；其他补充问题或 MCP elicitation 会明确拒绝，不隐式同意。CLI 与网页会话不能跨模式控制。

## 7. 本地退出、撤销与恢复

本地删除凭证：

```bash
coc-client logout --host A_ID
coc-agent logout --config ~/.config/coc-agent/agent.json
```

CW 在“会话记录”顶部选择 A 后点击“移除本地授权”。这些操作只删除本地保存的凭证，**不撤销 R 上的授权、不停止任务**。清除 A 的本地凭证前先单独停止常驻 Agent；运行中的进程可能仍持有原凭证。

真正停用设备时，在管理网页撤销对应凭证：

- 撤销 CC / CW：拒绝后续请求，并关闭使用该凭证的连接；其他客户端授权继续有效。
- 撤销 A：禁用主机，使其全部 CC / CW 授权失效，并关闭主机及相关客户端连接；Agent 收到撤销码后停止本地会话并退出。
- 需要重新接入时重新申请并批准登录；A 重新登录会产生新主机标识，客户端需要针对新 A 重新授权。

撤销不回滚已经发生的代码修改，也不保证所有外部进程已退出，需要时在服务器检查。最多 5 台有效的新协议 A；撤销后的记录不占有效主机配额。

## 8. 断线与当前边界

| 情况                    | 行为                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| 网页短暂断线            | 自动重连，先同步再允许发送                                                       |
| A 网络断线              | 退避重连，Codex runtime 不立即退出                                               |
| 客户端持续离线          | 默认保留 runtime 30 分钟，随后中断并关闭                                         |
| 审批无人响应            | 默认等待 10 分钟，随后拒绝                                                       |
| Agent 重启 / Codex 退出 | 原活动会话标记失败，可从 CW 本地历史恢复持久线程；原进程与未完成任务不会自动继续 |
| 提交后结果不明          | 不自动再次执行，先检查原会话与文件                                               |

每个 A 最多 4 个活跃 runtime；同项目默认一次只执行一个轮次。会话历史不再按总量或时间自动清理，实际容量取决于 Agent 磁盘；升级前已清理的数据不会自动恢复。单帧最多 256 KiB、网络队列最多 8 MiB，单条本地 Codex RPC 仍受约 8 MiB 缓冲限制；这些是单次处理限制，不是会话总大小限制。代码和模型凭据保留在服务器，但 Cloudflare 可见中转内容，目前没有端到端加密或不可信多用户的系统级隔离。

### 当前会话自动批准

CW 打开可控制的会话后，可手动勾选“自动批准当前会话”。默认关闭；开启后自动允许该会话中受支持的命令执行、文件修改及本轮额外权限请求，包括请求的网络 / 文件系统权限。“含额外权限”可展开查看范围和已自动提交数量。仅用于你信任的任务，额外权限仍受服务器和原 Codex 策略约束。

设置仅存在于当前页面的当前会话中，切换会话、进入管理页面或刷新页面后关闭，不保存到本机配置或传播到其他标签页。断线、离线或失去可用审批连接时暂停；恢复同一会话连接后继续，已自动发送的审批不会因重连、重复同步或反复开关而再次自动提交。关闭开关停止后续自动答复，已发送的决定不能撤回；结果未知时请核对远程状态，不重复提交。

不支持远程答复的交互仍需在原客户端处理。外部会话只有在 Agent 已配置共享审批接入、且当前会话显示可远程审批时才能开启；不会自动修改 Agent 的 sandbox、`allowApprovals` 或原 Codex 设置。没有启用此开关时继续逐项手动批准 / 拒绝。

### 大会话与客户端缓存

Agent 保存权威历史。Cloudflare Worker / Durable Object 只认证和双向转发，不保存历史正文。打开会话先取得最新一页（最多 200 条、正文约 96 KiB）；向上滚动到消息区顶部附近时自动异步加载更早内容，也可点击“加载更早内容”；读取期间显示加载状态并阻止重复请求，失败或断线后可重试。加载结果完整合并旧消息并保留阅读锚点，连续加载会累积显示所有已加载消息，不再按 400 条或 192 KiB 裁剪。在线读取和读取本地缓存的行为一致，加载越多占用的浏览器内存越多。“返回最新内容”回到有条数和字节上限的实时窗口，旧内容可以重新读取。超长内容显示读取按钮，每次最多读取 4096 个 Unicode 字符；“展开更多”累积读取，已经展开的正文完整保留，不再截掉前文；每一块按修订号保存到本地，重复阅读优先复用。执行和审批通过原有控制连接进行，读取历史不取得控制权。

CW 会记住上次选择的主机、项目和打开的会话。刷新页面或重新打开同一站点后，先确认主机仍在当前授权列表内，再从对应凭证身份的本地存储恢复原对话、已缓存消息和该会话草稿；无需再打开会话记录手动选择。主机离线时恢复已缓存会话并保持只读，未缓存内容等待上线。当前项目已移除时回到可用项目，不恢复该项目会话；切换或重新签发凭证不会读取旧身份保存的会话状态。会话已结束时查看历史；控制权冲突仍须手动处理，刷新不会自动接管、创建新会话或重发任务。

浏览器 `localStorage` 仅保存上次主机 ID，作为通过中继认证后的选择提示；项目和会话元数据、草稿、历史与待确认请求保存在按身份隔离的 IndexedDB 中，凭证仍由 HttpOnly Cookie 管理。移除本地授权后不再自动选择该主机；手动取消主机选择也会清除选择提示。清理站点数据会清除这些记忆，禁用或耗尽本地存储时可能无法恢复，但仍可手动选择已授权主机进行在线阅读。

CW 使用当前浏览器的 IndexedDB 保存已读取消息、历史页、内容块及主机 / 会话目录，按站点、凭证身份、主机和会话隔离。Agent 离线时，在仍可访问网页和完成中继认证的条件下，可选择已缓存会话查看已有内容；未缓存页面等待 Agent 恢复。浏览器配额、隐私模式或清理站点数据可能使缓存不可用，页面会提示并继续支持在线读取。“清理本机会话缓存”只清理该会话的浏览器副本。移除凭证和远程撤销不能擦除设备上已经保存的数据；需要时清理站点数据。缓存不作为唯一历史副本。CW 不再按条数、字节数或时间自动淘汰已读取历史页和正文块；切换会话、刷新与返回最新不会删除这些副本。存储容量由浏览器配额管理，达到配额时会提示。新事件和修订仍通过服务器同步，已缓存旧页不重复下载。

CC 保留原生 Codex TUI，通过额外的只读双向连接自动缓存连接期间的最新历史。以下命令读取历史并写入本机 SQLite，也适用于已结束的 CLI 会话：

```bash
coc-client history SESSION_ID --host A_ID
coc-client history SESSION_ID --host A_ID --before CURSOR
coc-client history SESSION_ID --host A_ID --seq CONTENT_SEQ --offset 0
coc-client history SESSION_ID --host A_ID --offline true
coc-client cache-clear SESSION_ID --host A_ID
```

`history` 输出 JSON，使用返回的 `cursor` 向前分页（归档游标可能为负数），使用 `contentSeq` 和 `nextOffset` 读取大内容；离线读取需要相同参数的页面此前已缓存。`cache-clear` 清理当前凭证和主机下的全部 CC 历史缓存，不影响 Agent。默认缓存位于 `~/.config/coc-client/history/<身份摘要>/agent.db`；可用 `COC_HISTORY_DIR` 或 `--cache-dir PATH` 指定根目录。SQLite 文件权限为 `0600`、身份目录为 `0700`，凭证原文不写入缓存。退出登录不自动删除缓存，新凭证不会复用旧凭证的缓存。

历史缓存不改变原生 TUI 的历史界面或 CLI 跨会话恢复策略。超过网络单帧的原生 RPC 结果通过 `history` 分块读取，不会因该结果断开整台 Agent。模型上下文窗口与磁盘空间仍受各自限制。

## 9. 从 0.2.x 升级

这是不兼容的认证升级，需同时更新 R、网页及原生程序。

1. 安装 `coc-agent` / `coc-client`，移除旧 `coc`；将 systemd 启动命令改成 `coc-agent run --config ...`。
2. 旧的 8 小时客户端凭证、旧 Agent 令牌和旧管理员 Cookie 不再接受；所有者密钥保持不变。
3. 停止旧 Agent，备份配置和数据目录；用 `coc-agent logout --config ...` 清除旧配置中的令牌，然后用 `login --config ...` 重新申请。项目与 dataDir 保留，A 标识改变。
4. CC 使用新的多授权凭证文件；旧 `~/.config/coc/credentials.json` 不自动导入。CW 对每个新 A 单独申请。
5. 原 `enroll`、`agent-enroll`、客户端 `revoke`、验证码兑换接口退出支持，统一使用网页审批和撤销。

SQLite 会话 / 事件格式不变；每个 dataDir 只运行一个 Agent。旧活动会话在重启时标记失败；CW 可从 Codex 历史恢复线程，但不恢复原进程或自动重发未完成任务。

## 10. 排错

登录申请过期或被拒绝时重新申请；核对目标 A 是否存在、已授权且未撤销。短期频繁申请会限流。看不到项目时检查 A 配置、目录权限；主机离线时检查进程、WSS、凭证和 Codex 版本。GLIBC 问题参见容器方案，不要替换系统 libc。

报告问题提供时间、主机 / 会话 ID、版本和错误码，不提供令牌、所有者密钥或模型凭据。已测范围及未完成验收见 [测试记录](TEST_REPORT.md)。

## 0.5.1 稳定化更新

Worker、网页和 Agent/CC 请配套更新到 0.5.1；旧 Agent 未完成能力协商时会返回 `AGENT_NEGOTIATING`，安装新包并重启 Agent 后再连接。升级前备份数据，合并重复或父子项目根目录。

聊天顶部持续显示服务器、项目与连接状态。历史和新建可直接访问；详情包含完整路径、会话标识与本机存储。相邻工具调用合并为默认折叠的一组，错误摘要保留文字提示；展开组后可逐项阅读、复制命令或输出。大回复继续按 Markdown 展示，“展开更多”累积读取；已展开正文完整保留，历史页和正文块优先从本地读取，缺失内容才向服务器获取。

审批一次显示当前请求与待确认数量，命令/原因/目标在正文中，拒绝与允许本次固定在下方。可前后切换审批；没有批量允许。文件请求按 itemId 关联已收到的变更事件，显示路径、类型及可展开 diff；缺少明细时明确提示。未知参数保留在请求详情。多个审批不会把输入和停止按钮推到视口之外。关闭文件面板时会明确确认取消传输；点击内部空白不关闭，Escape 与关闭按钮遵循相同语义。

允许选择已授权的离线服务器，读取此浏览器已保存的目录和历史；未缓存的内容需要等服务器恢复。网页与中继认证仍须可用，这不是完全离线 PWA。断线时远程任务可能仍在运行。临时票据错误会退避重试，控制冲突/撤销进入只读或需重新登录；“重新连接”和“接管控制权”分开，接管须确认目标。

任务草稿按中继、凭证身份、主机和会话保存在本机 IndexedDB；切换/刷新后恢复。发送前保存稳定请求身份，响应丢失时显示“待确认”并提供查询，禁止自动以新请求再提交。创建会话也保存独立请求 ID，刷新后可继续确认。清理会话缓存只删除历史副本，保留草稿与待确认身份；浏览器清除站点数据会移除这些本地信息。若浏览器无法保存待确认身份，会保留草稿并阻止提交，修复站点存储后再试；已缓存和在线历史仍可读取。桌面 Enter 发送、Shift+Enter 换行，触控设备 Enter 换行，用按钮发送；中文输入法组合态不会误发送。

消息区向上滚动接近顶部会自动异步加载更早消息，手动加载按钮仍可使用；历史向上加载会完整合并较早消息，保留阅读锚点及此前已加载消息；使用“返回最新内容”恢复有界实时窗口。列表搜索只搜索已加载记录；目录分页和 Codex 线程分页分别有“加载更多”入口。查看只读历史与恢复并继续有明确文案。缓存达到配额或无法打开时提示，权威历史保存在服务器。

文件面板显示服务器和项目、项目根目录面包屑、文件名/数量/进度。下载成功提示表示已交给浏览器，不能保证用户最终保存。上传提交响应丢失时保留 uploadId，重新打开面板可查询；完成结果与 SHA-256 在 Agent 保留 24 小时，跨 Agent 重启可查。24 小时后或发布与日志之间发生断电时，仍须人工核对目标文件。覆盖会检查版本，但本机其他写入者不参与原子比较交换；运行任务和上传可能并发改同一项目，请先停止相关写入再覆盖。

管理员“退出管理”会撤销当前服务端登录；可退出其他管理会话。轮换所有者密钥也使旧管理登录失效。A/CC 的本地 logout 仍只忘记本地凭证，不撤销设备授权。设备撤销与会话审批是不同操作。

### 原生命令与查询

```bash
coc-agent --version
coc-client --version
coc-agent doctor --config /path/agent.json
coc-client doctor --host HOST_ID
coc-client sessions --host HOST_ID --cursor LAST_ID
coc-client connect --host HOST_ID --project PROJECT_ID --request-id STABLE_ID
coc-client request STABLE_ID --host HOST_ID
coc-client request STABLE_ID --host HOST_ID --session SESSION_ID
coc-client history SESSION_ID --seq SEQ --offset 0
coc-client history SESSION_ID --seq SEQ --offset 4096 --revision REVISION
```

`--version` 为 JSON，含版本、提交、源码摘要、协议和能力；doctor 检查配置、Codex 0.164.0、TLS、项目权限、磁盘与 SQLite，不调用模型。HTTP DNS 解析使用系统 `/usr/bin/getent`，请保留发行版 libc-bin。CLI 在启动 TUI 前检查本机 Codex 版本。

目录响应是 `{data,nextCursor}`，每页最多 100 条。大内容首块自动保存 revision；后续内容缓存也绑定 revision，正文变化返回 `CONTENT_CHANGED`，从 offset 0 重新读取。CLI 历史观察连接会独立重连，缓存故障不终止 TUI。CLI 仍不支持接管已附着的 CLI runtime；请先结束旧会话再新建。

HTTP 每次请求的截止时间为 30 秒。`HTTP_TIMEOUT`、`RESULT_UNKNOWN` 或任务提交后断线均不能证明任务未执行。保留原请求 ID，先查询/核对历史；不要重新生成 ID 提交同一任务。

凭证通过同目录 0600 临时文件、fsync、原子发布与父目录 fsync 保存；并发登录/切换由锁拒绝，提示 `CONFIG_BUSY`。项目根目录不能重复、互为父子或通过符号链接规范化到相同目录；升级前合并这类别名配置。

### 权威数据库备份与恢复

```bash
python3 scripts/state-backup.py backup --data-dir /path/data --file /safe/snapshot.db
# 恢复前停止 Agent，并先另做当前状态备份：
python3 scripts/state-backup.py restore --data-dir /path/data --file /safe/snapshot.db
```

备份使用 SQLite 在线备份 API，包含 WAL 中已提交数据，输出权限为 0600，拒绝覆盖既有备份。恢复使用与 Agent 相同的实例锁；Agent 运行时拒绝恢复。恢复历史不会恢复 Codex 进程或回滚项目文件。秘密配置、Codex home 和工作区需要独立备份；不要只复制活动数据库的 `.db` 文件。

0.5.2 同时修复会话刚停止时读取尚未缓存的旧历史页：使用独立只读 Codex 进程，不向正在退出的运行进程发送历史请求。

### 0.5.4 性能改进

Agent 将细碎流式事件按 10 ms 定时器、128 条或约 128 KiB 阈值合并为批次，提交成功后才推送；停止、审批和非增量事件会先刷新待提交事件。10 ms 是收集定时器，不包含业务排队和实际磁盘提交耗时。文件扫描、读取及上传发布使用独立的有界工作队列，避免慢磁盘文件操作直接阻塞会话处理。

新版 Agent 在上传开始响应中声明四块传输窗口，网页据此并行发送最多四个 64 KiB 块；乱序块暂存并按顺序写入，重试内容必须一致，全部到齐后才发布。旧 Agent 不声明窗口时继续串行上传。下载首块固定文件版本后最多四块并行读取，版本变化即终止。本次不调整单文件 20 MiB、网络单帧 256 KiB 或覆盖确认规则。

网页历史连接负责实时事件，控制连接仍处理执行和审批；旧客户端继续接收兼容事件。草稿输入采用 150 ms 合并写入，切换会话和提交清空时立即持久化；突然关闭页面前最后 150 ms 的尚未提交草稿不保证保存。任务提交前的请求身份仍立即保存，失败时阻止发送。

升级到 0.5.4 可获得上述完整优化，现有凭证、配置、会话数据库及浏览器缓存继续兼容。Worker、网页和原生下载包配套发布；已有 Agent/CLI 按自动更新配置在空闲/命令结束时升级，或显式执行 `update`。首次启动会为上传完成记录增加到期索引，已有历史和请求去重身份保留。
