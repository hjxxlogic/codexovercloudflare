# 本机测试记录

日期：2026-10-24。版本：C++ 开发预览版 0.2.1。记录已测本机场景及生产发布冒烟，不代表全部需求验收。

## 环境

- 宿主：Ubuntu 20.04、glibc 2.31、GCC 9.4、CMake 4.2.3、Boost 1.71、OpenSSL 1.1.1f、SQLite 3.31.1、nlohmann/json 3.7.3。
- 工具：Node.js 22.17、Codex 0.164.0、clang-format 10。
- 集成容器：Debian Bookworm、GCC 12、Boost 1.74、OpenSSL 3、SQLite 3.40、nlohmann/json 3.11、真实 Wrangler/workerd 与 Playwright Chromium。
- 宿主与容器分别构建二进制，避免混用系统动态库。测试使用临时项目、凭据、端口和 DO 状态，上述本机测试未连接生产 `r.xlogic.cc`，生产冒烟另见下节。

## C++ 迁移验证

| 检查            | 证据与边界                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生构建        | CMake 构建 `coc-agent`、`coc`、`coc-tests`，支持宿主及 Bookworm 工具链。                                                                                                                        |
| CTest           | URL / 命令校验、RPC 白名单与线程隔离、服务器权限、凭据脱敏、SQLite 去重 / 回放 / 重启、旧请求指纹顺序、私有文件权限、独占 dataDir、真实子进程双向 RPC 与审批拒绝。测试断言在 Release 下仍有效。 |
| Vitest          | 两项保留的 TypeScript 协议边界测试：TLS / 回环 URL、帧大小和未知网页命令。                                                                                                                      |
| 原生 CLI        | 端到端直接启动 `coc`，验证登录、登记码、Agent 配置、文件权限、主机 / 项目 / 会话查询、结束会话、撤销和退出登录。TUI 启动夹具验证参数与环境变量票据传递。                                        |
| 中继与网页      | C++ Agent + 真实 Wrangler + 模拟 Codex + Chromium：认证、Origin 拒绝、单次登记、项目限制、流式输出、重复 prompt 去重、审批拒绝、接管、票据复用拒绝和历史回放。                                  |
| 故障恢复        | 测试代理断开 C++ Agent 连接，保留 Codex runtime 并恢复网页历史；设备撤销关闭活动连接并停止 Agent。                                                                                              |
| HTTPS / WSS     | 临时 CA 和服务器证书：可信证书连接成功；未知 CA、错误 SAN 主机名均被拒绝；验证 owner / device Bearer 认证头。                                                                                   |
| 真实 Codex 协议 | `npm run test:codex` 使用 C++ 进程层初始化 app-server 并创建只读临时线程，不提交模型任务。                                                                                                      |
| 真实文件任务    | `npm run test:task` 使用 C++ 进程层，在临时项目创建 `proof.txt`，精确校验内容为 `coc-smoke-ok\n` 并清理；调用已配置模型。                                                                       |
| 真实原生 TUI    | `npm run test:native -- --task`：Codex TUI → 本机 Worker → DO → 宿主 C++ Agent → Codex，完成一轮只读模型对话。通用 `command/exec` 和提交后新建线程探测仍被明确拒绝。                            |

`test:e2e` 的模拟 Codex 不执行命令、不调用模型；其中 TUI 启动夹具只记录参数，不验证终端 UI。真实 TUI 和真实文件任务由独立 smoke 证明，不能相互替代。

## 发现与修复

TLS 回归测试发现 Boost 旧 RFC2818 回调在 SAN 不匹配时仍可能回退到 CN。实现改用 OpenSSL 主机名 / IP 验证参数，HTTPS 与 WSS 使用相同约束。测试证书特意使用匹配 CN、错误 SAN，防止该问题回归。

原 TypeScript 的 JSON 指纹使用字段插入顺序，nlohmann/json 默认按键排序。C++ 显式保留旧请求字段顺序，避免已有 SQLite 去重记录在迁移后发生错误冲突。数据库表结构保留，重启会将旧活动会话标记失败。

宿主无法直接运行新版 workerd，仍使用 `Dockerfile.test` 容器；未替换宿主 glibc。原 TypeScript Agent / CLI 已删除，集成工具通过子进程调用 C++ 二进制。Node.js 仅用于云端、网页和开发测试工具。

## 0.2.0 首次生产发布

2026-10-24 已发布至 `https://r.xlogic.cc`，首发 Worker 版本为 `e25cac8c-596e-4351-b319-27b2d12c5674`；后续同步发布文档及最终源码包。域名绑定到 `codex-over-cloudflare`，生产 `OWNER_SECRET` 确认为 Cloudflare `secret_text`，未提交密钥。

- 用户确认浏览器可以直接访问首页。
- HTTPS 首页和 `/api/v1/healthz` 返回 200；未登录查询主机返回 401，跨域登录请求返回 403。
- 已用 Debian 12 C++ 客户端在生产完成登录、主机查询及退出，使用独立临时凭据文件；未登记设备或调用模型。
- 下载页提供 Ubuntu 20.04、Debian 12 的 Linux x86_64 包与源码包；三个线上包均通过 SHA256 校验。
- 解压 Ubuntu 原生包后，在不含 Node.js 的 PATH 下可直接执行 CLI。

本机路由器曾缓存新域名的解析失败；发布验证仅在测试进程 / 临时容器中指定 Cloudflare 边缘地址，保留完整 HTTPS 主机名与证书校验，未修改系统 DNS。用户浏览器的正常访问独立确认域名可达。

## 下载手册编码修复

2026-10-24 复现：线上 Markdown 文件字节为正确 UTF-8，但响应头 `text/markdown` 未声明字符集。新增静态资源响应头规则，将 `/downloads/*.md` 设置为 `text/plain; charset=utf-8`。

本机真实 Wrangler + Chromium 验证通过：响应状态 200，响应头包含 UTF-8，`document.characterSet` 为 `UTF-8`，正文包含“用户手册”和“服务端、客户端与网页”，且响应字节与文档源文件一致。此次仅修改网站响应头和文档，保留 0.2.0 已发布安装包。

生产 Worker 版本 `0d8322b3-5744-4909-bcce-2aeaab02b9a5` 已通过同一 Chromium 检查，线上响应为 `text/plain; charset=utf-8`；三个安装 / 源码包的 SHA256 校验仍通过。

## 0.2.1 一次性客户端登录

2026-10-24 本机验证通过：管理员网页生成验证码和浏览器链接；C++ CLI 兑换后保存 0600 凭据；链接清除地址栏 fragment，点击登录后获得网页会话。CLI 与网页并发兑换仅一次成功，已用验证码不能复用，未登录 / 客户端角色不能生成授权。验证码 5 分钟到期，登录凭据有效 8 小时；本轮未等待完整到期时间验证。

宿主和 Bookworm 容器原生构建、CTest、Vitest、TypeScript 类型检查、ESLint / Prettier、clang-format 检查、网页构建及 Worker dry-run 均通过。完整 `test:e2e` 使用真实 Wrangler / Chromium / C++ 程序与模拟 Codex，覆盖新登录流程及原有会话、流式输出、审批、重连和设备撤销；截图保存为 `.local/login-link.png` 和 `.local/login-session.png`。以上为本机验证，生产发布结果另行记录；未调用模型。

0.2.1 已发布至 `https://r.xlogic.cc`，Worker 版本为 `d79baa69-5514-4b34-9cb3-061c367d7d5f`，发布源码提交为 `e24ea6b`。生产 Chromium 验证管理员网页生成链接、浏览器确认登录、验证码复用拒绝及客户端生成授权返回 403；实际下载的 Debian 12 C++ CLI 完成验证码登录、主机列表和退出，使用独立临时凭据。两个二进制包和源码包线上 SHA256 校验通过；在线手册 UTF-8 响应头、浏览器字符集及源文件字节一致。测试登录均已退出，未登记 / 撤销生产设备，未调用模型。

## 网页流式文字顺序修复

2026-10-24 通过延迟首帧鉴权、立即完成次帧鉴权的回归测试复现：旧 HostRelayDO 在首帧前转发次帧；网页又按到达顺序拼接，导致回复单词错位。中转现按每条 WebSocket 连接串行处理，网页按持久事件 `seq` 排序、去重后拼接。

CTest、6 项 Vitest、类型与格式检查通过。完整 Wrangler + C++ Agent + Chromium 集成使用模拟 Codex 逐字快速发送英文和中文，验证原始事件顺序、完整文字及刷新页面后的两轮历史回放；原有登录、审批、重连和撤销回归通过。单元测试另验证乱序、重复事件、不同消息与轮次边界，以及一条连接等待鉴权时其他连接仍可转发。截图：`.local/stream-order.png`。本轮未调用模型，不涉及 Agent 升级。

已部署至 `r.xlogic.cc`，最终 Worker 版本为 `1020ab0d-eee2-4a90-9ddd-697f3d8f909e`。Chromium 加载线上实际网页代码，使用隔离的 API / WebSocket 夹具验证刻意打乱的实时片段和逆序、重复历史均还原为 `Hi! What would you like to work on?`，完成状态保持空闲；该检查不操作真实生产会话，也不代表生产模型输出验收。线上用户手册 UTF-8 校验、下载页，以及保留的 0.2.1 清单、校验文件和三个发布包均验证通过。截图：`.local/stream-production.png`。

## 尚未完成的验收

- 生产 DO 休眠唤醒、跨网络会话和发布断线；HTTP 发布冒烟不覆盖这些场景。
- 4 会话持续 8 小时、P95 延迟、1 GiB 配额与慢客户端长期压力。
- CLI 再附着、Agent 重启后的旧线程恢复、超大事件分片。
- 全部审批类型、全部原生 TUI 功能、macOS / Windows 和移动浏览器兼容性。
- 组织账户、强租户隔离、端到端加密；这些不在首版本机实现范围。

复现命令见 [开发说明](DEVELOPMENT.md)。不要将本记录视为 A-01 至 A-09 全部验收完成。

## 0.3.0 统一设备授权与双程序

2026-10-24：本地程序调整为 `coc-agent` / `coc-client`，不再构建和分发旧 `coc`。项目配置和 SQLite 格式保留，认证 version 2 为不兼容升级，所有旧凭证需要重新授权。

- 宿主 Ubuntu 20.04 和 Debian 12 容器均构建两个程序；原生共享 login 接口负责参数、路径、申请 / 轮询和状态检查。
- CTest 通过；13 项 Vitest 覆盖多年后凭证仍有效、旧凭证拒绝、并发审批 / 单次领取、轮询秘密、请求过期 / 拒绝、未领取授权清理、撤销释放有效主机配额、角色 / 目标 A / 管理权限隔离，以及原有协议和流式顺序回归。多年有效性由时钟推进测试验证，不代表多年实测运行。
- 真实 Wrangler + C++ 程序 + Chromium 集成通过原生 A 自行登录、CC 多 A 私有凭证文件、管理员网页审批 CW、持久化 HttpOnly Cookie、多授权刷新保留、两个在线 A 在不同标签页独立控制、撤销后保留另一个 A 的授权、会话和中文 / 英文流式历史、审批拒绝、幂等、票据复用拒绝、Agent 重连及管理撤销关闭活动 CW / CC / A 连接。只使用模拟 Codex，不调用模型。
- TLS 测试通过可信证书连接、未知 CA 拒绝、SAN 主机名错误拒绝；真实 Codex `initialize` / `thread/start` 与原生 TUI 经完整本机中继初始化通过，未提交模型任务。沙箱最初阻止临时监听和 Codex 进程，授权后重跑通过。
- TypeScript 类型、ESLint / Prettier、clang-format 检查和完整 build / Worker dry-run 通过。Docker 生成目录的所有权已恢复后完成宿主构建。
- 截图保存在忽略目录 `.local/auth-multiple.png`、`.local/auth-session.png`。发布结果另行记录。

浏览器 Cookie 的本地期限由浏览器约束，网站在主机查询时续写；清理 Cookie 或长期未访问仍需重新申请。管理会话单独有效 8 小时。以上不覆盖真实模型任务、生产长连接负载和 DO 休眠恢复。

### 0.3.0 生产发布

已于 2026-10-24 发布至 `https://r.xlogic.cc`，Worker 版本为 `ee650082-1424-47da-babb-9442217d554b`（100% 流量），发布源码提交 `a56361e27273b105abf870d2c39c57dc861fe4fd`。

真实 Chromium 管理网页核对并批准本次临时 A / CC / CW 请求：实际下载的 Debian 12 两个程序完成登录与状态查询，CW 的 Secure / HttpOnly 长期 Cookie 在刷新后保留；CC / CW 访问管理接口被拒绝。测试后撤销本次创建的全部设备授权，确认 CC 旧凭证返回 401；未修改已有生产设备，未启动生产 Codex runtime 或调用模型。

两个发行包和源码包线上 SHA256 均与清单一致，下载目录仅提供 0.3.0；二进制包包含 `coc-agent` / `coc-client`，不含旧 `coc`。在线用户手册响应头包含 UTF-8，浏览器实际字符集为 UTF-8，正文与文档源文件字节一致。生产截图：`.local/auth-production.png`。源码和发布证据已提交推送；`v0.3.0` 标签指向发布源码提交，证据文档另作后续提交。

## 0.3.1 角色专用 API Key

2026-10-24：增加与配对审批并行的 API_KEY。CC Key 创建时固定目标 A；A Key 首次使用事务绑定自己的 A。登录返回元数据，原 Key 保存在 token 字段并直接用于鉴权。

- CTest 与 17 项 Vitest 通过，新增覆盖角色必填、CC 创建必须选 A、跨角色 / 跨 A 拒绝、直接 Bearer 鉴权、并发首次绑定只创建一个 A、十年后仍有效、只保存摘要、未使用 Key 撤销、客户端独立撤销与 A 级联撤销。
- 原生 Ubuntu 20.04 / Debian 12 编译通过。类型、ESLint / Prettier、clang-format、完整 build 和 Worker dry-run 通过；可信 TLS、未知 CA 与错误主机名回归通过。
- Wrangler + Chromium + 两个 C++ 程序新增场景通过：管理员网页生成两类 Key、环境变量 / 标准输入登录、配置中的 token 等于原 Key、A 重复登录保持绑定、CC / A 活动 WebSocket 撤销立即关闭。完整回归发现本地 workerd 偶发在已交付 4001 关闭帧后延迟结束 TCP，导致测试超时；诊断确认客户端已收发关闭帧。测试客户端设置 1 秒关闭握手期限，并明确断言收到 4001 撤销码；配对 CC 另外按实际凭证摘要精确选择。

本轮使用模拟 Codex，不调用模型；多年有效性为时钟推进验证。截图在忽略目录 `.local/api-key-management.png`。修正测试传输关闭等待后，完整端到端回归已通过，包含原配对 CC / CW / A 撤销、重连、多 A 多标签页、流式历史、审批与原生 TUI 启动。生产发布证据另行补充。

### 0.3.1 生产发布

已于 2026-10-24 发布至 `https://r.xlogic.cc`，Worker 版本 `3ea27462-6e50-488d-bde0-ad73581c7d24`，部署记录显示 100% 流量；源码提交 `9dd7a32f188d4fa8c45c843117535735593bf6b0`，`v0.3.1` 标签指向该提交。

初次生产验证时新网页与 Worker 已生效，Registry 新操作仍短暂返回 `NOT_FOUND: Unknown operation`；随后同一部署下生成 / 撤销探测成功，完整验证重跑通过。这与 Cloudflare 文档描述的 Worker / Durable Object 代码更新最终一致传播相符，未清空存储或更改已有设备身份。开发文档已补充部署后等待实际接口就绪的检查。

真实 Chromium 管理网页生成 A Key 和指定目标 A 的 CC Key；实际下载的 Debian 12 两个程序完成直接 Key 登录，配置中的 token 等于原 Key。配对 CC 与 CW 登录继续可用，CW Secure / HttpOnly 持久 Cookie 刷新保留，Key 和配对客户端均不能访问管理接口。撤销 CC Key 后旧 Key 返回 401，撤销 A Key 后本次 A 停用；本次临时设备与 Key 已清理，未修改其他生产设备，未运行生产 Codex runtime 或调用模型。

Ubuntu 20.04、Debian 12 二进制包与源码包的线上 SHA256 均与清单一致；下载清单版本为 0.3.1，源码提交与发布标签一致，二进制包含两个程序及 `--api-key` 登录支持。在线用户手册与源文件字节一致，响应头和真实浏览器字符集均为 UTF-8。截图：`.local/api-key-production.png`、`.local/auth-production.png`。本节和发布传播注意事项为源码发布后的证据补充，不改变该标签或已发布源码包。

## 0.4.0 CW 工作台与 Codex 本地历史

本机验证，不连接生产、不调用模型：

- Ubuntu 20.04 / Debian 12 原生 Release 构建、CTest、18 项 Vitest、TypeScript、ESLint / Prettier、clang-format 与 Worker dry-run 检查通过；可信 TLS、未知 CA 与错误主机名回归通过。
- 真实 Wrangler / Durable Object + 原生 Agent / Client + Chromium，使用确定性 Codex 协议夹具：既有认证、角色 / 主机隔离、审批、接管、重放、撤销、多标签页与断网重连继续通过。
- 新增历史列表 cwd 过滤、中文长摘要 UTF-8 完整性、异项目 / 异主机恢复拒绝；浏览器恢复用户 / 助手消息及工具结果，继续发送新任务；分页去重、搜索、Markdown 表格 / 代码块、安全链接、默认折叠工具、键盘提交、功能分页、Escape 与菜单自动收起通过。
- 390px 手机布局无横向溢出。截图：`.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`、`.local/cw-chat-markdown.png`；已目视检查布局并将可能缺字的图标替换成 SVG。
- 与真实 Codex `0.164.0` 本地生成的 JSON Schema 核对 `thread/list`、`thread/read`、`thread/resume` 参数；本轮没有用真实模型生成 / 恢复实际用户对话，也没有验证超大历史。既有 256 KiB 单帧限制保留，归档和其他 cwd 的线程不在当前列表中。

需要同步更新 Worker / 网页和原生 Agent。生产验证记录另行补充。

### 0.4.0 生产发布

2026-10-24 已发布至 `https://r.xlogic.cc`。Worker 版本 `735711eb-c7f8-47bc-b49b-f02129edc4ba`，部署记录为 100% 流量；源码提交 `bf561359aaaa6186adfb82e8ad5341121886eca7`，GitHub `master` 与 `v0.4.0` 发布标签已推送并核对。

线上三个包（Ubuntu 20.04、Debian 12 和源码）SHA256 与清单及本机发布产物一致，下载清单版本 / 提交与发布源码一致；包内只有 `coc-agent` / `coc-client` 两个运行程序，已在匹配系统检查 help。在线用户手册与源文件字节一致，响应头与 Chromium 字符集均为 UTF-8。首页 / 健康检查正常，未登录业务返回 401，跨域管理登录返回 403。

真实 Chromium 管理页创建临时 A / CC Key，下载的 Debian 12 两个程序完成直接 Key 登录，CC 配对登录与 CW Cookie 登录继续通过，验证角色隔离和撤销后的 401。使用该临时 A、独立临时目录及确定性模拟 Codex 连接生产中继，新版下载 Agent 的本地历史查询 / 恢复、恢复后 CW 发送任务及流式回复、Markdown 表格、工具默认折叠、功能页切换均通过；不调用模型，不涉及用户原有设备或真实项目。临时设备 / Key 已撤销，测试 Agent 停止。截图 `.local/cw-production.png`。

本次发布只更新云端网页 / Worker 和下载包；已有远程主机须安装 0.4.0 `coc-agent` 并重启服务才能使用新增历史接口。发布证据另行提交，不改写标签或已发布源码包。

### 未发布：专注聊天与工作区文件

2026-10-24，本机源码验证，不代表生产发布。原生与网页构建、TypeScript、ESLint / Prettier、clang-format、CTest 和 18 项 Vitest 通过。真实 Wrangler 与 Chromium、确定性模拟 Codex 的端到端回归验证：

- 桌面 1280×900、手机 390×844 聊天占满可用窗口、消息独立滚动、输入框可见且页面无横纵溢出；主机 / 项目、会话记录 / 详情默认隐藏，经菜单操作后显示。历史恢复、Markdown / 折叠工具、停止、审批、重新连接和设备撤销继续通过。
- 工作区文件菜单上传、下载 150003 字节二进制内容，分成多个 64 KiB 段后逐字节一致；默认覆盖被拒绝，明确确认后替换成功。目录中的符号链接未列出，关闭面板返回专注聊天。
- 文件接口拒绝未登录、CLI 角色、未授权主机、未注册项目、越界路径及超过 20 MiB 的上传请求。CTest 另外覆盖上传所有者 / 根目录隔离、只读下载 / 禁止上传、重复段一致性、未完成文件不可见、取消保留旧文件、目标变更阻止覆盖和下载版本冲突。

截图位于 `.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`、`.local/cw-chat-markdown.png`、`.local/cw-workspace-files.png` 和 `.local/cw-workspace-files-mobile.png`。本轮不调用模型；文件功能需同时升级网页、Worker 和 Agent。

### 未发布：双向历史与客户端缓存

2026-10-24，本机源码验证，未部署生产。原生 / 网页构建、TypeScript、ESLint / Prettier、clang-format、CTest、23 项 Vitest 和 Worker dry-run 通过；原生 TLS 回归覆盖可信 HTTPS / WSS、未知 CA 和错误主机名拒绝。

- CTest 覆盖 450 条历史分页、稳定游标与并发新增消息、消息版本补发、30 万字节中文内容逐块还原、内容版本冲突和会话隔离、负序号归档排序、长期保留及本机缓存读写 / 清理。Vitest 覆盖只读通道绑定认证会话、不占控制租约、非法指令拒绝、独立主动推送、旧版本不能覆盖新消息和 UTF-8 显示预算。
- 真实 Wrangler / Durable Object、原生 Agent / Client 与 Chromium 的完整端到端回归通过。确定性 Codex 夹具包含 510 条历史，最新十条各约 1 MiB、合计超过本地 8 MiB RPC 缓冲；验证恢复时排除完整 turns、每个本地 RPC 只读取一项、最新页优先、旧页按需读取、中文内容分块及已关闭会话读取尚未导入的历史。
- CC 经 Worker WebSocket 读取历史后写入按身份隔离的 SQLite，离线以相同参数读取缓存通过。CW 保存 IndexedDB 后，在测试主动阻断历史 WebSocket、主机 / 项目查询返回离线错误时，仍能恢复已缓存目录并显示会话内容；截图 `.local/cw-history-cache.png` 已目视检查。
- 既有登录 / 撤销、角色与主机隔离、去重、审批、独占控制 / 接管、原生 TUI 启动、断网重连、Markdown、移动布局及工作区文件回归均通过。Worker dry-run 仅打包，不上传或发布。

已与真实 Codex `0.164.0` 本地生成的协议 Schema 核对历史接口。本轮没有调用模型、读取真实用户超大历史或执行八小时长稳测试；会话总量不再触发自动清理，但磁盘、SQLite、单条本地 RPC、网络单帧与队列仍有各自限制，升级前已删除的数据不能恢复。CW 缓存恢复要求网页及中继认证仍可用，不代表完整离线 PWA。需要同时升级 Worker、网页、Agent 和 CC。
