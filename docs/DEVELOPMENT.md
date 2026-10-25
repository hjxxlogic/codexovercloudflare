# 开发与本机测试

## 1. 目录与工具

- `native/include/coc/`、`native/src/`：C++17 公共接口、Agent、CLI、网络、进程和 SQLite。
- `native/tests/core.cpp`：CTest 与真实 Codex smoke。
- `apps/relay/src/`、`apps/web/src/`：TypeScript 中转与 React 页面。
- `packages/protocol/`：云端 / 网页的类型与 Zod 校验；C++ 按相同协议单独校验。
- `tests/`：Vitest 协议边界、真实 Wrangler/Chromium 集成；`tests/support/` 仅为原生进程和断网注入工具。
- `scripts/`、`examples/`、`docs/`：初始化、TUI smoke、配置、systemd 和文档。

Linux 编译依赖：C++17、CMake ≥ 3.16、Python 3（构建来源生成）、Git、Boost.System ≥ 1.71、OpenSSL、SQLite3、nlohmann/json ≥ 3.7。Ubuntu / Debian：

```bash
sudo apt-get install build-essential cmake python3 git libboost-system-dev libssl-dev libsqlite3-dev nlohmann-json3-dev clang-format
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 2
cmake -E chdir build ctest --output-on-failure
```

本机二进制不依赖 Node.js，运行时需要与编译目标兼容的动态库。可执行 `sudo cmake --install build --prefix /usr/local` 安装。当前验证 Linux x86_64；不承诺跨发行版直接复制二进制。

云端、网页和 TypeScript 测试工具需要 Node.js ≥ 22.17（建议 24），执行 `npm ci`。Codex 固定 `0.164.0`，Agent 启动时检查版本。

## 2. 常用命令

| 命令                                              | 用途                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `npm run build:native`                            | CMake Release 构建 Agent、CLI 与原生测试。                 |
| `./build/coc-agent run --config /path/agent.json` | 启动 C++ Agent。                                           |
| `./build/coc-client hosts`                        | 使用 C++ CLI，默认中转 `https://r.xlogic.cc`。             |
| `npm run agent -- ...` / `npm run client -- ...`  | 调用上述二进制的开发快捷入口，需先构建。                   |
| `npm run setup:local`                             | 生成被忽略的开发秘密，拒绝覆盖已有配置。                   |
| `npm run dev`                                     | 构建网页并启动 `127.0.0.1:8787` Wrangler。                 |
| `npm run build`                                   | 原生构建、网页构建、类型检查和 Worker dry-run；不部署。    |
| `npm run typecheck`                               | 检查保留的 TypeScript 与测试工具。                         |
| `npm run lint` / `npm run format`                 | ESLint / Prettier 检查与修正。                             |
| `npm run lint:cpp` / `npm run format:cpp`         | 使用 clang-format 检查 / 修正 C++。                        |
| `npm test`                                        | CTest 加 Vitest；不调用模型。                              |
| `npm run test:e2e`                                | C++ Agent / CLI + Wrangler + 模拟 Codex + Chromium。       |
| `npm run test:tls`                                | 本地 CA 验证 C++ HTTPS / WSS 的信任链、主机名与认证头。    |
| `npm run test:codex`                              | C++ 进程层连接真实 Codex，初始化只读线程，不提交模型任务。 |
| `npm run test:native`                             | 原生 Codex TUI 经完整本机中继初始化，不提交模型任务。      |

`test:e2e` 前构建 C++、网页并安装 Playwright Chromium。`test:native` 需要 Python 3、Docker、`coc-local-test` 镜像及宿主 `codex`；中转运行在 Linux host network 容器，C++ Agent / Codex 在宿主运行。旧 `--relay` 参数仍可传入，但不再切换到测试专用 bridge。

真实模型测试会使用已配置的模型服务：

```bash
npm run test:task
npm run test:native -- --task
```

第一项使用 C++ 进程层在临时项目创建并校验 `proof.txt`；第二项验证原生 TUI 经 Worker、Durable Object 和 C++ Agent 的模型对话。测试使用临时端口和凭据，不连接生产。

## 3. Ubuntu 20.04 容器方案

新版 workerd 需要更新的 glibc；用 Bookworm 容器运行中转和浏览器，不替换宿主系统库：

```bash
docker build -f Dockerfile.test -t coc-local-test .
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'npm ci && cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2 && npm run build:web && npx playwright install chromium && COC_AGENT_BINARY=.local/build-container/coc-agent COC_CLI_BINARY=.local/build-container/coc-client npm run test:e2e'
```

容器和宿主分别使用构建目录，防止混用 OpenSSL / glibc 动态库。容器默认 root，构建文件写入挂载目录；不要挂入生产凭据。宿主已有匹配浏览器缓存时，可挂载缓存并设置 `PLAYWRIGHT_BROWSERS_PATH`；`COC_BROWSER_PATH` 可指定其他兼容浏览器路径。

开发中继：

```bash
docker run --rm --init --network host -v "$PWD:/workspace" coc-local-test npm run dev
```

Wrangler 只监听回环地址。其他操作系统需自行适配端口映射和监听地址，不应向公网暴露开发 HTTP。

## 4. 风格、配置与迁移

0.3.0 仅构建和安装 `coc-agent` / `coc-client`。`native/src/login.cpp` / `native/include/coc/login.hpp` 共用参数解析、配置路径、设备授权轮询和凭证状态检查；各程序保留自身角色命令。`login`、`logout`、`status` 和 `--relay` / `--name` / `--config` 语义一致。Agent 使用 `COC_AGENT_CONFIG`，客户端使用 `COC_CREDENTIALS`；客户端配置版本为 2，包含按 R / A 索引的 entries 和 selected。

设备认证协议升级到 version 2，旧宽权限 client / agent / owner Cookie 不再接受。重新使用所有者密钥登录管理网页，A 自行申请授权，CC / CW 按 A 授权。旧项目和 SQLite 格式保留，systemd 改用 `run --config`。具体迁移顺序见用户手册，不能继续使用原登记或验证码流程。

C++ 使用 2 空格、snake_case 函数、PascalCase 类及 `.clang-format`，测试失败不得依赖 Release 会禁用的 `assert`。TypeScript 保持 strict、ESLint、Prettier，测试命名 `*.test.ts`。添加功能时同时更新 C++ / Zod 协议与跨语言测试。

- `.dev.vars`、`.local/owner-secret`：开发秘密；所有者密钥至少 32 字符。
- `.local/agent.json`：设备令牌与项目配置；Agent 登录写入权限 `0600`。
- CC `COC_HISTORY_DIR/<身份摘要>/agent.db`：本机 SQLite 缓存；CW `coc-history` IndexedDB：分页、消息版本、内容块和目录缓存。两者均不替代 Agent 权威历史。
- `.wrangler/`：DO 开发状态；删除会丢失设备登记与登录会话。
- Agent `dataDir/agent.db`：SQLite 会话、去重、完整事件及消息投影；WAL，历史不按时间或总量自动清理，请求身份及确定结果长期保留，防止迟到重试重复执行。SQLite 须提供 JSON 函数。首次升级在 SQLite 内建立投影索引，迁移耗时和磁盘开销取决于既有日志规模。
- `~/.config/coc-client/credentials.json`：CLI 凭据；可用 `COC_CREDENTIALS` 指定路径。

停止旧 TypeScript Agent 后，直接用 C++ Agent 读取原配置和 dataDir。升级增加 request_states、bodies/chunks 及表达式索引，旧投影按需迁移；启动后旧活动会话标记失败，不恢复旧进程。每个 dataDir 只运行一个 Agent；C++ 使用文件锁拒绝第二个实例。不要直接复制活跃 WAL 数据库的单个 `.db` 文件；停机备份或使用 SQLite 备份机制。

`codexArgs` 只允许管理员配置受信任的包装器；不能接受客户端输入。CLI / Agent 均使用参数数组启动程序，不使用 shell 拼接。systemd 示例直接执行 `/usr/local/bin/coc-agent`。

## 5. 部署准备

`wrangler.jsonc` 已配置 `r.xlogic.cc` 自定义域名及账号，关闭 workers.dev 和预览 URL。生产发布必须携带网页和原生下载包，并使用独立生产密钥；具体步骤见 [发布操作](RELEASE.md)。发布后的 HTTP 冒烟测试不替代跨网络会话、DO 休眠唤醒和长期负载验证。Agent 使用非 root 用户，配置 Codex home、项目权限与持久 dataDir，参见 [systemd 示例](../examples/coc-agent.service)。

TLS 在 Cloudflare 终止；当前不提供端到端加密或不可信多用户隔离。完整目标与验证边界见 README 和测试记录。

## 0.3.1 API Key

共用 login 接口支持 `login --api-key`，从 `COC_API_KEY` 或隐藏终端 / 标准输入读取，成功后将原 Key 存入现有 token 字段，沿用私有配置与业务接口。终端参数不接受 Key 值。Key 创建 / 绑定 / 撤销由 RegistryDO 负责，CC API Key 目标在创建时校验，A 首次绑定使用事务，重复使用不创建第二个 A。创建响应之外不返回秘密，不增加兑换令牌。

`tests/device-auth.test.ts` 还覆盖 CC / CW 无目标申请及留言长度、管理员选定服务器、缺失 / 无效 / 撤销目标拒绝、重复审批和单次领取。`tests/e2e.ts` 验证浏览器填写多行留言、管理员按文本查看并选择服务器、未选择不能批准，以及多 A Cookie 和刷新保留。CW 审批由 RegistryDO 在事务内校验 hostId，CC 同样在审批时指定目标；原生配对登录使用 `--message`，不再要求 `--host`，API Key 登录仍要求该参数。此流程需同步构建 Worker、网页及 CC 下载包；e2e 的原生登录辅助函数在审批时传递 hostId，并校验 CLI 留言与实际保存的目标。

`tests/device-auth.test.ts` 覆盖角色必填、目标固定、直接 Bearer、多年有效、并发绑定和级联撤销；`tests/e2e.ts` 通过管理网页生成两类 Key，实际运行两个原生程序并验证保存的 token 就是 Key、重复登录绑定一致和活动连接撤销。测试截图在忽略目录 `.local/api-key-management.png`。

发布后必须验证 Registry 新接口实际可用，再完成登录验收。Worker 与 Durable Object 代码在全球最终一致传播，可能出现新网页已上线而 Registry 暂时仍返回旧版本的 `NOT_FOUND: Unknown operation`；不能仅依据 `wrangler deploy` 成功就宣告功能验收通过。参见 [Cloudflare 代码更新说明](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#code-updates)。等待传播后重试验证，不要清空生产 DO 状态或更改设备身份。

## CW 网页开发

网页使用 react-markdown / remark-gfm 渲染聊天 Markdown。`main.tsx` 管理 CW / 管理员模式及功能分页、会话记录顶部的 CW 连接 / 授权操作、点击外部/Escape 关闭的菜单与会话生命周期；管理登录 / 退出只在管理员模式展示，授权 hash 直接进入管理员模式；`events.ts` 负责有序去重和流式组装。新增本地历史接口须同时更新 Worker 路由校验与原生 Agent 校验，不向网页开放任意 app-server RPC。

`tests/e2e.ts` 的确定性协议夹具包含本地历史及异项目线程，验证历史列表过滤、恢复历史与继续对话、分页 / 搜索、Markdown / 安全链接、折叠工具、移动端宽度和功能菜单。截图输出 `.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`；测试不调用模型。历史功能需要与 Worker 一起更新原生 Agent。

专注聊天布局的浏览器回归还检查：含常驻上下文头的聊天区超过窗口高度的 85%、空闲消息区超过 65%，输入区保持在窗口内且页面没有横纵溢出；主机 / 项目、会话列表 / 详情默认不占聊天空间。测试通过菜单访问历史与详情，检查选中后自动关闭、Escape 退出，以及执行中的停止和审批仍可操作。

工作区文件 UI 在 `files.tsx`，通用请求在 `api.ts`；`native/src/files.cpp` 负责文件访问、分段与临时上传，Agent 生命周期负责清理。新增操作须同步更新协议 Zod、Worker 路由与原生校验。CTest 覆盖越界路径、符号链接、所有者 / 项目隔离、只读策略、二进制内容、重试、取消和覆盖冲突；浏览器回归上传 / 下载超过两个分段的二进制文件并逐字节比较、拒绝默认覆盖及确认替换，截图 `.local/cw-workspace-files.png`。不调用模型。

## 双向历史开发

`/ws/v1/history/:sessionId` 是经过角色 / 主机 / 会话校验的只读 WebSocket，不取得或更新控制租约。请求为带 `requestId` 的 `page`（`before` 或 `after` 二选一）/ `content`；Agent 同时可主动发送 `event`。使用 `npm run test:e2e` 覆盖真实 Wrangler、原生程序及 Chromium IndexedDB；测试把 `COC_HISTORY_DIR` 指向临时目录。无需模型调用。

消息以稳定 `seq` 排序，以递增 `revision` 同步更新；`snapshotSeq` 是首次快照同步位置，后续按响应的 `cursor` 推进，不能使用交错到达的实时消息推进补发游标。历史分页按 `seq`，补发按 `revision`，负 `seq` 表示惰性导入的既有 Codex 历史。大内容分块通过 `revision` 检测读取期间的变化。

## 稳定化回归与构建来源

`npm run test:ui` 在本次 dist 上执行合成 API/WS 的 Chromium 交互压力测试，覆盖票据 503 重试、默认折叠、草稿、0/1/3/10 审批和短视口、离线入口及弹窗焦点。历史回归使用短消息和较大消息两组 600 条记录，分别验证手动加载及向上滚动自动分页，延迟响应与连续滚动事件不重复发请求，越过 400 条 / 192 KiB 后仍完整有序、保留阅读锚点，返回最新恢复有界窗口，重新加载命中 IndexedDB 页。菜单回归验证 CW / 管理员入口互斥、底部切换按钮在桌面 / 手机短视口可见、键盘焦点、管理员登录 / 退出及设备授权深链接，并检查切换保留 CW 草稿且不增加 attach 请求。连接设置回归验证其位于会话列表上方，选择主机 / 项目、新建会话及多主机授权使用同一面板。截图 `.local/ui-stability/cw-loaded-history.png`。`npm run test:backup` 验证活跃 WAL 备份和带实例锁恢复。`COC_ARTIFACT_DIR` 可隔离截图输出目录，避免覆盖旧证据。

原生测试增加 100000 关闭会话/4 个活动会话、有界目录、1 MiB 分块流、持久提交查询、配置锁和 HTTP/TLS 停滞回归。C++ 与 Zod 共读 `tests/protocol-fixtures.json`。CI 运行常规门禁、真实 Wrangler/Chromium 与 ASan/UBSan；不调用模型。可用 `-DCOC_SANITIZE=ON` 本地构建，Clang 下 `-DCOC_FUZZ=ON` 生成协议模糊测试入口。单次短跑不代替长期模糊测试。

构建生成的 build.hpp 含提交与源码摘要；运行二进制 `--version` 可检查。Python/Git 仅为构建依赖，本机运行不需要 Node.js。旧容器没有 Git 时可显式设置 `COC_TEST_BUILD_METADATA` 指向本机生成的测试元数据；它强制 dirty=true/verified=false，禁止作为发行包来源。更新 Dockerfile.test 的镜像后无需此兼容选项。

网页构建保留下载目录，防止重新构建意外删除已准备的原生包。发布仍须校验版本/摘要一致、干净源码及完整目标平台产物；CI 成功不自动发布。Observability 采样 10%，应用日志只包含元数据；不记录正文、令牌和 Key。实际日志的访问与保留期限由自托管者配置。

### 流式存储基准

```bash
# DELTA 为每个事件的字符数，BYTES 为每会话目标字符数，最后参数为最长秒数。
./build/coc-tests --benchmark 1 1048576 120
./build/coc-tests --benchmark 10 1048576 120
./build/coc-tests --benchmark 100 4194304 120
```

四个会话交错追加，输出 JSON 包括实际完成量、耗时/CPU、每 16 个事件采样的 P95、进程 RSS、数据库和 WAL 峰值，并验证尾部正文一致。`completed=false` 表示达到时间上限，只是部分负载，不能当成完整吞吐测量。它只测 Store，不包含网络心跳和 Cloudflare；八小时全链路测试须另行安排。

`npm run protocol:generate` 从 Zod 生成 `docs/protocol.generated.json`，`protocol:check` 检查是否过期。JSON Schema 无法表达的 refinement 仍由运行时验证器执行；这不是 C++ 实现代码生成或多版本兼容承诺。CI 使用固定 Node 版本和锁文件；首次 Actions 的 npm ci 发现 @humanfs/node 0.16.8 声明的 retry ^0.5.0 尚不存在；overrides 固定已发布的 @humanwhocodes/retry 0.4.3，隔离目录干净安装已通过。远端随后确认锁文件 type-check 0.5.0 归档不存在，已固定现有 0.4.0 并修正归档地址；CI 安装失败会输出公开错误注解，远端结果仍须单独观察。

## 原生更新验证

`npm run test:update` 使用回环 HTTP 发行目录与本机编译的最小 ELF，验证实际 Agent/CLI 的检查、SHA256、构建身份、协议、降级拒绝、目录穿越归档隔离、更新锁、关闭配置、原子替换及旧文件保留；不访问生产或调用模型。`python3 tests/native-update.py --automatic` 另验证干净 Release CLI 自动安装和空闲 Agent 释放数据库后 exec；该模式须先提交源码并重新构建，不对脏开发构建开启自动更新。增加 `--busy` 可验证候选已准备但现有 runtime 存活时不会切换，停止会话后下一次空闲检查才重启。Agent/CLI 路径可用 COC_AGENT_BINARY / COC_CLI_BINARY 指定。

TLS 专用夹具显式配置 `autoUpdate: false`，确保带业务凭据的 TLS 请求计数不混入公开更新下载。自动更新的无凭据下载、超时及安装由 `test:update` 与干净构建扩展场景独立验证；CI 将各回归命令分步运行以明确失败来源。

## 性能回归（2026-10-25）

在原生/网页构建后执行 `npm test`、`npm run test:ui` 和 `npm run test:cache`。后两项需要已安装 Playwright Chromium；`test:cache` 使用独立浏览器 context 和本地拦截页面，不访问外部服务器，覆盖历史长期保留、修订合并写入、按 scope 清理和草稿落盘。`test:ui` 覆盖完整历史窗口与重复翻页不增加历史网络请求。

Store 基准：

```bash
./build/coc-tests --benchmark 1 1048576 10
./build/coc-tests --benchmark-batch 1 1048576 10
```

两者在独立临时库中交错写入四个会话，分别每次提交 1 条和最多 128 条。批量模式的 P95 是整批调用延迟，不能直接与单事件 P95 比较；未模拟 Agent 的 10 ms 收集定时器，也不能代替端到端延迟和慢盘压测。不要并行运行基准。Agent 每 30 秒日志增加 eventBatches、batchedEvents、eventBatchMaxUs，以及 fileRequests、fileQueueBytes、bufferedEvents；前三项在每次采样后清零，最大耗时不是 P95。

实现和实测边界见 [性能修复记录](perf-fixes-2026-10-25.md)。完整端到端仍使用上述 Bookworm 容器方案，Worker dry-run 只打包，不发布。

## 指定目标的 Agent 审批（0.5.5）

设备申请的新字段为 `requestedHostId`，不要将旧 `hostId` 解释为显式目标，否则旧客户端会意外改变管理员分配行为。Worker、网页及使用新命令的原生程序需要一起更新；新版客户端核对响应中的目标，不兼容旧 Relay 时明确失败。Agent 审批 API 只接受服务端鉴权产生的摘要，Registry 事务内再次检查撤销状态和主机作用域。

`tests/device-auth.test.ts` 覆盖 cli / web 指定目标、请求列表脱敏、其他主机 / 未指定 / Agent 申请拒绝、管理员改绑拒绝、伪造请求体无效、角色隔离、过期与拒绝、在途撤销、API Key 撤销以及管理员 / Agent 并发只签发一次。`tests/e2e.ts` 使用真实原生 `requests / approve / reject`，验证 Agent 服务停止时批准 CC、运行时批准 / 拒绝 CW、管理页目标锁定、HttpOnly Cookie 刷新保留，并保留管理员选择目标的原有用例。使用确定性 Codex 夹具，不调用模型。截图通过 `COC_ARTIFACT_DIR` 保存。

Agent 启动提示回归在同一端到端测试中预置本机、异主机及未指定申请，验证仅本机申请输出提示、控制字符转义、无轮询秘密泄露且未自动批准；运行中新增 CW 申请，验证周期发现和原申请不重复提示。进程 harness 只代理申请查询并捕获程序输出，可注入 503 检查后台失败不阻止 Agent 在线、随后自动恢复。生产实现位于原生 Agent，不依赖测试工具。检查使用独立线程池，单次 5 秒超时，退出等待在途检查完成。

## 离线唤醒回归

构建原生程序和网页后执行 `npm run test:wake`，用本地 HTTP / WebSocket 夹具验证真实 Agent 的唤醒配置及 capabilities、CC 离线唤醒等待与幂等重试，以及 Chromium 的管理员配置和 CW 上线刷新；不调用模型。`npm test` 包含主机配置权限、URL 脱敏、管理员覆盖/禁用/回退、在线跳过、并发及 DO 重建限流、失败限流与共享 C++ / Zod URL 校验夹具。UI 截图默认保存 `.local/wake-ui/`，可用 `COC_ARTIFACT_DIR` 修改。

## Windows x64 原生构建

建议将源码检出到 Windows 本地 NTFS 路径，避免 UNC 工作目录限制。安装 Visual Studio 2022/2026 的“使用 C++ 的桌面开发”、Windows SDK、CMake ≥3.16、Python 3 和 Git。原生构建不需要 Node.js。使用 vcpkg（设置 `VCPKG_ROOT` 为其目录），仓库 `vcpkg.json` 固定依赖注册表基线；推荐 `x64-windows-static`，同时静态链接 MSVC CRT。不要使用 Win32/x86 生成器。

```powershell
cmake -S . -B build-windows -A x64 "-DCMAKE_TOOLCHAIN_FILE=$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" -DVCPKG_TARGET_TRIPLET=x64-windows-static
cmake --build build-windows --config Release --parallel 2
ctest --test-dir build-windows -C Release --output-on-failure
.\build-windows\Release\coc-agent.exe --version
.\build-windows\Release\coc-client.exe --help
```

Windows CTest 使用原生模拟 Codex 子进程，不调用模型；覆盖 UTF-8 配置、排他锁、SQLite 历史与去重、Windows 路径拒绝规则、分块传输/覆盖、参数引用、stdio RPC 和进程退出。符号链接测试仅在系统允许创建链接时执行。Linux 专用故障注入、Docker TUI 和真实 Codex 验收仍需按对应环境运行；Windows CI 不代替真实 Codex TUI、沙箱及长期压力验证。

CI 的 `windows-x64` 作业执行 MSVC Release 构建、CTest、启动检查和 ZIP 打包；不部署。正式包需在干净提交上生成：

```powershell
python scripts/package-release.py --build-dir build-windows/Release --platform windows-x64
```

结果位于 `dist/web/downloads`，包含 ZIP、源码、SHA256 和构建身份。静态依赖许可证默认取自该构建目录的 `vcpkg_installed/x64-windows-static`；自定义安装目录时为打包命令添加 `--dependency-dir <triplet目录>`。Windows 更新先采用手动整包替换，不能使用 Linux 的 ELF/tar 原地更新流程。不要混用 Windows 与 Linux 构建目录。云端、网页与现有 TypeScript 集成脚本继续使用文档中的 Linux 测试环境。
