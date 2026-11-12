# 测试说明

## 2026-11-12 CW 多会话布局与独立预览滚动

新增 `node node_modules/tsx/dist/cli.mjs tests/ui-stability.ts --multi-session`，并纳入默认 `npm run test:ui`：在两个项目中打开独立会话，验证草稿隔离、切换不重新附着、左右／上下双面板、输入区可见性与宽度、键盘调整分割比例、关闭标签以及手机布局。从空标签再次选择已打开会话复用已有控制器。会话测试使用模拟后端，不调用模型。

`npm run test:markdown` 增加桌面及手机长文滚动验证：正文存在有界滚动区域，可聚焦并用 Ctrl + End 到达文档末尾，下载工具栏仍在视口内。保留原有公式、表格、代码、Mermaid、全屏与 CSP 检查。预览布局只保留一处定义，避免 CSS 加载顺序导致 flex 被覆盖。

网页构建、TypeScript、完整 ESLint / Prettier、`npm test`（16 项 CTest、37 个 Vitest 文件 / 418 项测试）、完整 `npm run test:ui` 和 `npm run test:markdown` 均通过。关闭最后一个标签不恢复刚关闭的会话；错误提示限制在各自面板内，保留工具栏点击区域。截图保存在忽略目录 `.local/ui-stability/multi-session-horizontal.png`、`multi-session-vertical.png`、`multi-session-mobile.png` 及 `.local/workbench-evidence/preview-scroll-*.png`。本次未执行线上发布、真实模型调用或真实手机／Safari 验证；标签集合和分屏布局不跨页面刷新恢复。

2026-11-09 的 0.6.18 移除同项目单写连接及模型任务互斥。`native-endpoint` 覆盖同项目独立控制、待决票据、同 session 接管和关闭隔离；`test:runtime` 保持同项目两条轮次同时运行并验证停止其中一条不影响另一条；`test:e2e` 使用 3 / 5 个独立浏览器并发创建同项目 session，全部进入审批后分别处理，关闭其中一个后其余继续发送任务。项目 Terminal 互斥及全局资源预算保留。最终 CI 六项必需作业全部成功，37 个 Vitest 文件 / 411 项测试通过；已使用 CI 制品部署主站及本机 Agent / CLI。首次 CI 刷新失败的修复、发布来源和验证结果见 [0.6.18 发布记录](MULTI_SESSION_RELEASE_20261109.md)。

本文列出当前入口与验证边界；本次集成结果见文末。历史预览不代表当前提交或线上部署，准确来源见 [r2 历史发布记录](R2_DEPLOYMENT.md)。

## 2026-11-08 历史订阅失效与侧栏状态修复

新增 `tests/native-history-subscription.ts`，纳入 `npm run test:delivery`。使用真实原生 Agent、加密端点、模拟 Codex 及临时 SQLite，在任务运行时删除测试订阅行，分别验证定时重试与新事件发布的失效通知、同一逻辑流重新订阅、每路仅通知一次、任务及 turn 身份保留、控制命令继续工作，最后显式中断任务。修复前该用例复现 `history_retry_failure` 与全局关闭；修复后通过。故障注入仅修改测试数据库，不操作用户会话。

`npm run test:delivery` 的可靠交付、历史保留恢复及新增订阅失效回归全部通过。CTest 全部 16 项通过；补充直接响应与无 requestId 异步通知两种客户端恢复场景后，最终 Vitest 全部 37 个文件 / 409 项测试通过。原生 Agent / 组件与网页构建、TypeScript、完整 ESLint / Prettier、C++ 格式检查通过。

`npx tsx tests/ui-stability.ts --active-sessions` 通过：侧栏无状态圆点或可见状态文字，会话图标颜色区分状态，图标和会话行提供悬停说明，保留读屏标签；活动会话排序、跨项目选择、桌面及手机明暗主题继续通过。截图位于忽略路径 `.local/ui-stability/active-sidebar-mobile.png` 和 `active-sidebar-dark-mobile.png`。未在真实 iPhone / Safari 验证，未执行 GitHub Actions 或部署；本机运行中的 Agent 未替换。

后续已按用户明确要求提交、跳过 Actions 并部署本机 Agent / CLI 与主站 CW，稳定性及资源校验通过，见 [发布记录](HISTORY_SUBSCRIPTION_FIX_RELEASE_20261108.md)。

2026-11-08 归档 / 删除功能的完整本机复测见 [本机完整测试记录](LOCAL_ALL_TESTS_20261108.md)，包含真实模型、sanitizer、三个 Linux 发行版、跳过项及首次失败与重跑结果。

2026-11-08 欢迎页及左侧活动会话优先显示的本机检查、浏览器场景和截图见 [活动会话验证](ACTIVE_SESSIONS_20261108.md)。

## 基础检查

| 命令                                | 覆盖                                             |
| ----------------------------------- | ------------------------------------------------ |
| `npm run typecheck`                 | TypeScript 类型                                  |
| `npm run lint` / `npm run lint:cpp` | ESLint、Prettier 与 clang-format                 |
| `npm run protocol:check`            | schema 生成文件一致性                            |
| `npm test`                          | CTest 与 Vitest，不调用模型                      |
| `npm run build`                     | 原生/网页构建、类型检查与 Worker dry-run，不发布 |

## 集成与专项入口

先构建原生和网页，浏览器测试先安装 Playwright Chromium。集成测试使用原生 Agent / CLI、本地 Wrangler、SQLite 和模拟 Codex；与真实 Codex 的检查分开。

| 命令                                                      | 验证目标                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `npm run test:opaque`                                     | 真实 Worker/Agent/Chromium 加密互通、权限、去重和业务不可见性 |
| `npm run test:e2e`                                        | 完整原生、Relay、浏览器会话、审批和文件流程                   |
| `npm run test:tls`                                        | 原生 TLS 与 Access 入口                                       |
| `npm run test:access:web`                                 | 浏览器 Access 与访客授权                                      |
| `npm run test:wake`                                       | 离线唤醒与 UI                                                 |
| `npm run test:ui` / `npm run test:cache`                  | 工作台交互、布局、缓存与恢复                                  |
| `npm run test:projects` / `npm run test:projects:e2e`     | 多项目、管理身份、目录边界与浏览器流程                        |
| `npm run test:delivery`                                   | 可靠传输、丢包重连、历史恢复与保留策略                        |
| `npm run test:operations` / `npm run test:operations:web` | 原请求持久化、去重、结果未知和恢复                            |
| `npm run test:configuration`                              | 远程配置替换、冲突与重启回执                                  |
| `npm run test:uploads:web`                                | 上传完整意图与恢复                                            |
| `npm run test:runtime`                                    | 进程、队列、审批、RPC 资源隔离                                |
| `npm run test:markdown`                                   | 公式、图表沙箱、流式解析、危险内容和手机视口                  |
| `npm run test:terminal`                                   | 原生 PTY、控制证明、输入去重与项目互斥                        |
| `npm run test:terminal:e2e`                               | Chromium → Worker → Agent → 隔离 PTY                          |
| `npm run test:backup`                                     | SQLite 一致备份、恢复与实例锁                                 |
| `npm run test:release`                                    | 发行来源和部署工具拒绝路径                                    |
| `npm run test:update`                                     | 当前自动更新、校验失败拒绝                                    |
| `npm run test:billing` / `npm run test:billing:web`       | 按需通讯、刷新与通知行为                                      |
| `npm run test:retry`                                      | Agent 固定 30 秒重试、初始化恢复与显式停止                    |

Worker 授权专项：`npx vitest run tests/relay-order.test.ts tests/device-auth.test.ts`。覆盖握手后的双向零授权查询、DO 重建、退休连接、授权变更、到期及持久失效事件重试。稳定数据转发不能依赖短时缓存命中；控制面授权仍需完整检查。

DO 清理与调度专项：`npx vitest run tests/relay-order.test.ts tests/expiry.test.ts tests/do-state.test.ts`。覆盖关闭通知发送失败时退休上行及全部关联客户端、关闭握手抛错仍完成清理、重复生命周期回调不重写未变化的 alarm、调度等待期间附件期限变化及到期队列清空后的 alarm 取消。断连故障和重复 alarm 用例在修改前失败、修改后通过；本地回归不代表已部署或已核对线上节费。

2026-11-07 DO 生命周期优化本地验证：安装 libsodium 开发依赖后，CMake 配置和完整原生构建通过；`npm test` 全部通过（15 项 CTest、36 个 Vitest 文件 / 398 项测试），包含真实 C++ / TypeScript 加密通道互通，CTest 没有跳过项。上述专项加 `tests/device-auth.test.ts` 共 4 个文件 / 79 项通过。TypeScript、受影响文件 ESLint / Prettier、网页构建与 Wrangler Worker dry-run 通过。完整测试日志为 `.local/coc-do-optimization-full-tests.log`，原生构建日志为 `.local/coc-do-optimization-native-build.log`；没有发布线上 Worker。

Agent 重试专项使用真实原生进程、Socket 与实际计时，不加速重试定时器。`test:retry` 覆盖连续 HTTP 401 / 403、协议不匹配、4001、非法配置、Codex 不可用、状态锁占用、配置修复和锁释放后的自动恢复，以及在重连 / 初始化等待中明确停止后不再尝试。`test:billing` 同时验证空闲零业务轮询、Pong 超时后固定延迟与连续连接失败后的恢复，并包含该重试专项。

Linux PTY 可单独运行 `ctest --test-dir build -R native-terminal --output-on-failure`。需要 Bash、bubblewrap、prlimit 和可用 namespace；工具存在但启动失败不能当作通过。原生测试入口与实际跳过项以 CTest 输出为准。

## 真实 Codex

- `npm run test:codex`：真实 app-server 协议，不调用模型。
- `npm run test:native`：真实原生 TUI，经过完整本地中继；需要 Linux、Python 3、Codex 及可用 workerd，旧宿主使用测试容器。
- `npm run test:task`、`npm run test:native -- --task`：提交真实模型任务，使用已配置的服务和项目环境。

## 当前格式与无邮箱记录测试

邮箱授权测试验证无邮箱网页凭据的显式认领、原凭据失效及不同邮箱不能重复认领；无邮箱会话连接后才进入当前邮箱列表；结构完整的未标记 SQLite 库可重开读取，绑定归属持久保存且邮箱相互隔离。

配置测试验证 `codexUseProxy` 被拒绝；自动更新单元测试验证废弃 `autoUpdate.intervalHours` 提示后忽略且保留有效选项，类型或平台错误禁用自动更新并继续。真实 Agent / CLI 配置回归分别验证带废弃字段的 Agent 完成连接及重启、无效更新选项的 CLI 启动 TUI 和管理连接，并校验诊断输出；历史 adapter 验证缺失或非 `paginated` 模式拒绝。存储测试覆盖 SQLite、项目目录、DO 到期标记及浏览器记账格式错误，验证不转换、不丢弃原状态。请求测试覆盖缺少 `operationInstance`、用稳定身份替代准入代次及 HTTP Terminal 字节操作的明确拒绝。

2026-11-05 自动更新配置容错本地验证：`npm test`（11 项 CTest、35 个 Vitest 文件 / 505 项断言）、`npm run test:configuration`、`npm run test:update`、`npm run lint`、`npm run lint:cpp`、`npm run typecheck` 通过。配套 CLI 安装辅助验证通过源码身份检查、原文件备份、权限保留及符号链接拒绝。CI 与实际部署结果另记部署文档。

诊断收集脚本使用独立临时目录验证配置与项目结构复制、凭据键及 URL 脱敏、缺失文件继续、损坏 JSON 拒绝和源文件不改写；真实 x0–x9 文件收集需由有权限的管理员执行，尚未代为运行。

启动修复及代理同步脚本基于已收集的十个用户结构，在独立临时目录验证预览不写入、六份空旧登记转换、项目及凭据保留、十用户代理同步、正常项目登记不变、备份内容一致，以及非空旧回执和过期源摘要拒绝。尚未对真实用户执行修复。

## 验证边界

测试使用独立配置和数据目录，不清理生产状态。截图、日志、测量与本机证据放在忽略的 `.local/`，可用 `COC_ARTIFACT_DIR` 指定浏览器证据目录。

确定性测试不能替代真实 Cloudflare Access 策略、跨网络长稳、平台账单、所有 Codex 版本兼容性或线上部署验证。逻辑预算不是 RSS、cgroup 或物理磁盘承诺。模型输出、真实文件变化和外部 Codex 来源需在对应环境单独验证。

CI 必须核对准确提交的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64 全部必要作业。运行中、已触发或仅部分通过不构成发布验证。部署后的运行身份与下载包身份分别核对，见 [发布操作](RELEASE.md)。

## 历史证据边界

初始不透明中继源码 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859` 的 [Actions 41764690561](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 六项必需作业成功，随后部署至独立 r2。原 master 授权复核修复 `a1fc79f3a80e74ee8310739bd4d69934ab48e331` 的 [Actions 41961015104](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41961015104) 全部成功。它们均不代替本次准确提交门禁。

0.6.8–0.6.13 的多次 Web 预览包含局部测试和 `ciVerified=false` 发布；未将未运行的原生或完整 CI 计为通过。逐次 SHA、版本、摘要与线上验证范围见 [r2 历史发布记录](R2_DEPLOYMENT.md)，详细阶段流水可从 [固定源提交](https://github.com/hjxxlogic/codexovercloudflare/tree/f2de6f8ccea342575ce99b8c852f893f938285c3/docs) 复现。界面结构归入 [界面说明](CW_HAPPIER_UI_PLAN.md)，实际官方 Web 对照保留于 [实测记录](HAPPIER_WEB_COMPARISON_2026-11-05.md)。

## 2026-11-06 不透明中继集成验证

输入固定为 master `7c344413607becd70444341882951844a6e72dbd` 与源 `f2de6f8ccea342575ce99b8c852f893f938285c3`。合并提交 `0de34e4` 保留双方父提交，后续修正继续在 `integrate/opaque-relay`；源码版本统一为 0.6.14。生产站、下载、现有 Agent 和 tag 未发布；后续授权的 r2 本地预览见下文。

| 本机检查             | 实际结果                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖、构建与静态检查 | npm ci、完整 npm run build（原生 / Web / Worker dry-run）、typecheck、lint、lint:cpp、protocol generate/check 通过                                                              |
| 基础与 sanitizer     | 15 项 CTest、36 个 Vitest 文件 / 390 项测试通过；独立 ASan/UBSan 构建的 15 项 CTest 通过                                                                                        |
| 加密、队列与历史     | test:opaque、test:queue、delivery / retention、operations、configuration、projects、runtime 通过；真实加密通道与浏览器覆盖队列去重、取消、立即执行、刷新恢复和观察历史          |
| 认证及资源           | TLS / Access、browser-access / guest-access、真实计时 billing、billing:web、wake 通过                                                                                           |
| Web 与真实协议       | 默认 test:ui 和 navigation、新增恢复行为、markdown/cache、projects:e2e、operations:web、uploads:web、native Terminal、native-login、真实 Codex 无模型初始化与 native smoke 通过 |
| 工具                 | release / update / backup、agent-deploy 19 项、cloud-deploy、deploy-web、Access 工具 4 项、CI 输出工具通过；均为隔离测试，没有执行生产 apply                                    |
| 完整 PTY E2E         | 默认完整入口通过原生协议 / CLI、TUI 恢复、3 / 5 浏览器交接、真实隔离 PTY、历史 / 审批、文件断点与手机关闭、双主机及撤权；未使用 --skip-tui                                      |

`test:ui` 默认联合当前导航和行为回归：快照超时恢复、400/500 不清登录或草稿、语言持久化、模型选择、未知提交结果、0/1/3/10 审批和丢回包后不重复发送。`--navigation` 只运行导航，`--behavior` 可单独复现行为；`--legacy-layout` 保留旧布局供历史复现。队列 UI 由真实加密 `test:opaque` 验证。当前桌面与手机截图见 [界面说明](CW_HAPPIER_UI_PLAN.md)。

旧数据库演练使用准确旧提交 `666d1af` 编译其原 Store / Projects，创建含会话、队列、历史、回执与项目登记的 SQLite 0/1。新 Store / Agent 使用原配置、凭据和 dataDir 连续启动两次；旧项目登记逐字节不变，旧程序拒绝升级后的版本 2。SQLite backup API 验证包含已提交 WAL；备份写入失败保留旧版本并可重试，子进程文件大小限制分别模拟备份写入不足、备份已完成后的迁移 WAL 写入失败；两次失败后均可由旧程序验证原记录及旧版本，再由新 Agent 成功重试。入口为 `python3 tests/legacy-upgrade.py --legacy-source <隔离旧源码> --agent build/coc-agent`，CI 固定 checkout 旧提交；版本探测使用隔离模拟程序，不依赖系统安装 Codex。

自动更新补充演练 `COC_LEGACY_FIXTURE=.local/legacy-source/build/coc-legacy-upgrade python3 tests/native-update.py --automatic --busy` 通过：公开 Agent 的空闲更新保留旧配置、项目与账本；组件 Agent 注入内部控制，验证已准备的更新等待活动会话结束后才安装。模拟候选 ELF 只记录重启，不冒充实际新版业务运行；实际 CI Agent 包另作隔离启动验收。CI 固定运行完整自动 / 忙时组合。

DO fixture 覆盖多页事务备份、批次提交后中断与重启、同实例重试、重复迁移、wakeUntil 持久化、活动旧 lease / 待决控制预留 / 未完成权限操作 / 未知未来版本失败关闭。Registry 身份授权保留原结构。发布时仍需确认线上未决状态、导出快照及验证实际对象；已授权的真实用户 SQLite 副本离线演练见下文；仍没有生产 DO 副本或在线迁移证据。

中间失败如实保留：`0de34e4` 的 [Actions 42151853443](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42151853443) 因格式及 sanitizer CONFIG_BUSY 失败；锁处理中补齐 EINTR 重试与显式解锁后，`0ecf0b4` 的 [Actions 42154302199](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42154302199) 五个平台 / sanitizer 作业全部成功，regression 在加密浏览器的尺寸切换导航竞态失败。后者已修正并由本机 test:opaque 重跑通过。`15a705d` 与 `0d71c41` 的 regression 暴露升级演练依赖 CI 未安装的 Codex，现已改为隔离版本探测并在本机重跑通过。`adfd2ed` 的 sanitizer 日志显示 CTest 零失败（14 项通过，native-terminal 因该作业未提供隔离工具而跳过；真实 PTY 在 regression 和本机独立验证），但依赖安装耗时约 11 分钟导致作业超过 20 分钟总时限而被取消；将作业时限调为 45 分钟，保留全部检查及断言，取消仍不计为通过。中间提交和运行中作业均不作为最终门禁。

`a57a160` 的完整本机 PTY E2E 通过，CI 五项平台 / sanitizer 成功，但综合回归在三浏览器的只读就绪等待失败。现场截图与角色记录显示一写两读均已建立；旧测试按全页文本匹配，与隐藏的上下文头部重复文本发生严格定位竞态。就绪判断现限定实际只读提示区域，保留启用发送、一写多读、审批、刷新、交接及关闭断言。本机后续重跑通过 3 / 5 浏览器交接，并暴露聊天重连提示遮挡手机文件面板关闭按钮；将连接提示置于手机工作面板下方，保留全屏层级及实际点击关闭断言。进一步的清理前快照确认角色建立正确，但输入框在只读切换时移除，单次 inputValue / isEnabled 的默认等待可耗尽整个 30 秒屏障；将单次定位限制为 1 秒，在原总期限内重试。失败截图和文本在任何会话清理前统一保存，避免清理改变现场；导航断线注入前后均确认发送已启用，即真实控制握手完成。

最新完整 E2E 的五浏览器交接进一步发现旧草稿与新输入混合：本机记录未恢复完即开放输入并启动控制握手。现先恢复草稿 / 模型 / pending，再开放输入与握手；UI 行为回归使用真实 IndexedDB 读取完成回调的人工屏障，验证暂停时输入禁用且未 attach，释放后原草稿完整、可输入及可发送。修复后的默认完整 E2E（启用真实 PTY、未使用 --skip-tui）、默认完整 UI、typecheck 和 lint 本机重跑全部通过；功能源码 `d4a3f4e` 的 [Actions 42171580611](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42171580611) 六项必需作业全部成功。后续数据库验证工具 / 文档提交单独运行 CI，不以先前结果替代。

本机矩阵与重跑日志保存在忽略的 `.local/opaque-merge/`，截图原件位于 `.local/ui-stability/`、`.local/screenshots/`；不提交配置、数据库或凭据。功能源码的六项作业、GitHub artifact 摘要和真实 CI musl Agent 的隔离旧库启动结果见 [制品证据](assets/opaque-integration/ci-artifacts.json)。最终归档提交与合入 master 仍需其自身 CI。未执行生产变更、真实线上迁移、外网长稳或真实用户业务模型任务。一次本机补充更新演练因旧 fixture 主机身份不匹配而意外触发启动修复模型；该子进程只检查临时状态和公开下载索引后随演练结束，未部署，已修正身份并在测试内部固定禁用启动修复，后续重跑通过。

## 2026-11-06 r2 本地预览与真实数据库副本

在线连接副本进一步要求保留旧会话的主机前缀：新增 owner 专属 `hostRestore`，只创建缺失主机并签发新凭据，拒绝覆盖既有身份。设备授权专项 43 项通过，包含新凭据鉴权、冲突 / 非法 ID 拒绝、匿名入口拒绝与原路由回归；typecheck / lint 通过。`scripts/prepare-r2-database.py` 使用独立配置、数据库和项目登记，固定 r2 目标，不复制原控制端口或凭据。

用户授权在 Actions 后台继续时发布 r2 本地构建；干净源码 `fd53702`、`ciVerified=false`。部署健康和公开资源字节核对，以及 r2 的真实 Cloudflare / 临时原生 Agent / Chromium 加密验收通过，含任务、去重、历史、文件、控制接管和管理 UI。生产 Worker / DO、路由、Access 及两既有 Agent 保持原样，测试凭据清理通过。详见 [r2 发布记录](R2_DEPLOYMENT.md)。

`tests/user-database-upgrade.py` 对经在线备份 API 复制的约 167 MiB 真实用户版本 0 数据库验证通过：47 张原表、129 个会话、17,436 条事件、42,128 条历史全部原行摘要一致；真实 Store 连续打开两次后版本为 2，升级前备份完整且输入快照不变。辅助程序只打开 Store，没有 Agent / Codex / 中继连接或原会话重启；原数据库与服务不替换，副本和完整逐表摘要仅留私有忽略目录。该结果不代表原会话进程恢复或生产在线迁移。用户确认 Agent 可以重新登录，只要求数据库可迁移；未复制生产 DO 或旧凭据。

真实数据库副本在线补充：保留原主机 ID、r2 新签 Agent 凭据后，真实加密接口两页返回全部 129 个旧会话，三份历史序号和元数据与快照一致；Chromium 打开原关闭会话的历史、刷新和手机显示通过，无页面异常。没有发送任务、创建会话、接管控制或复制生产 DO；临时浏览器授权撤销，独立副本 Agent 保持连接供查看。原数据库及两现有 Agent 未替换，私有截图 / 原文不提交。[无正文证据](assets/opaque-integration/r2-real-database.json)及来源见 [r2 记录](R2_DEPLOYMENT.md)。

## 2026-11-06 主站生产验收

主站本地云端 / Agent 9c546cc 与已完成 CI 4a9d441 的四个平台下载已部署；Actions 42178474355 六项必需作业全部成功，原生构建输入一致，GH-Proxy 下载和线上包摘要核对通过，Worker 执行模块保留。真实 SQLite 0→2 与 DO 迁移完成：130 个原会话、43,000 个历史标识、191 条请求账本保留；三组历史及桌面 / 刷新 / 手机显示通过。当前本机 CTest 15 项、Vitest 393 项、部署回归 19 + 18 + 5 项，以及新增回退保护 2 项、构建输入一致性 2 项通过。身份、完整摘要和验收边界见 [主站部署记录](PRODUCTION_OPAQUE_DEPLOYMENT.md)。

## 2026-11-06 CW 左栏入口调整

本地 `build:web`、`test:ui:navigation` 通过：普通 CW 用户隐藏管理员入口；已登录管理员的切换按钮位于设置右侧，设置页无重复入口；桌面和手机切换可用，手机切换后关闭抽屉；会话列表无附加继续按钮，正文只读续接、历史恢复及草稿保留回归通过，无页面错误。网页单独发布新增生产 / r2 目标匹配与拒绝跨目标回归，`tests/deploy-web.py` 6 项及 Cloud 部署 18 项通过。界面截图：[桌面](assets/cw-sidebar-20261106/desktop.png)、[手机](assets/cw-sidebar-20261106/mobile.png)。

该网页已部署主站，版本 ID `8e893754-4b08-430e-8a34-a08b4170bb67`，线上静态资源字节与构建一致，保留 Worker 模块摘要并通过发布后核对。线上资源配合模拟身份响应的桌面 / 手机浏览器检查通过；具体范围见 [网页部署证据](assets/cw-sidebar-20261106/deployment.json)。

## 2026-11-07 发布回归入口修正

`847fbc5` 的 [Actions 42340184545](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42340184545) 五项原生平台 / sanitizer 作业成功，regression 在刷新后发送按钮等待超时，未发布。继续本机验证发现先前左栏调整后，多个浏览器用例仍从设置寻找已移除的管理员入口。首次管理员认证改为实际授权链接入口；已认证邮箱管理员仍通过左栏切换。保留所有者登录、权限、九个管理面板、双主题、桌面 / 手机及空闲请求断言，不绕过认证或减少门禁。加密浏览器在发送失败时输出现场状态，便于区分草稿、控制握手和待确认请求；不将偶发通过当成已解释原失败。

完整 E2E 还发现外部会话恢复用例仍寻找已移除的列表附加“继续对话”按钮。现先选择会话行，历史会话通过正文的续接操作恢复；保留外部队列、只读同步和原客户端审批断言。更新后的加密端到端、默认完整 UI、网页空闲用量、邮箱 / guest 授权本机通过；完整 E2E 的后续重跑结果单独记录。

计费回归耗时基线取自首次 CI 日志：regression 到失败共 1,610 秒，其中 `test:billing` 为 514 秒（31.9%）；空闲 / 心跳 / 恢复约 330 秒、延迟读取约 32 秒、失败重试约 152 秒。三组临时状态完全隔离，改为并行执行且等待全部退出，任一失败使组合命令失败；保留真实生产时钟和全部断言。预计节省约 184 秒，占该轮已运行总时间 11.4%；这不是完整成功流水线的占比，也不代表删除超时验证。实际并行耗时另行记录。

本机并行实测通过：读取 31.8 秒、重试 151.3 秒、空闲 / 心跳恢复 330.3 秒，组合约 5 分 30 秒；相对该 CI 串行 514.2 秒减少约 184 秒（35.8%），占首轮已运行 1,610 秒的 11.4%。正常退出与单组失败的组合门禁单元测试 2 项通过，lint / typecheck 通过。生产重连与心跳时限未修改。日志位于 `.local/release-0.6.15-billing-parallel.log`。

Cloud 发布工具补充 `--gh-proxy`，沿用下载发布工具的公开 Actions 代理路径，只代理制品字节，不代理鉴权 API、签名地址或生产请求。回归覆盖直连 / 代理资源身份一致及私有 / 未确认仓库在下载前拒绝，完整制品摘要、来源和全部 CI 门禁保持必需。

公开制品下载提速还沿用下载发布工具的四线程方式；缓存命中逐包复核，下载后立刻验证 GitHub 摘要，所有下载完成才组装清单。并行线程写入不同归档，CI 门禁、来源和发布前后核验不变。

## 2026-11-07 0.6.15 发布完成

准确源码 `54e210c` 的 [Actions 42343337541](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42343337541) 六项必需作业全部成功，regression 为 34 分 34 秒。主站 Worker / 网页与四平台下载已发布，版本 ID `58c24e00-9db1-4b3d-a274-2f51800d254d`。线上 0.6.15 健康、未授权 HTTP / WebSocket 拒绝、静态资源逐字节及五个归档摘要核验通过；没有安装或重启已有 Agent。后续测试提速和下载工具改动独立于已验证制品来源，实际范围、完整摘要与限制见 [发布记录](RELEASE_0.6.15_2026-11-07.md)。

## 原生代理 DNS 修复（2026-11-07）

原生代理回归使用 `relay.invalid`，本地代理直接终止隧道，验证目标无需本机 DNS 即可完成 HTTP / SOCKS5、无认证 / 用户密码认证、HTTP / WebSocket 的 16 种 IP / 域名组合；带认证的 WebSocket 路径同时验证本地 TUI 桥接及可靠传输。检查 CONNECT / SOCKS5 请求保留目标域名、应用 Host 保留原目标、代理认证不泄漏到目标，并保留拒绝 / 超时及本机地址绕过检查。

`npm run test:tls` 增加 `relay.invalid` 的 HTTPS / WSS 用例，使用临时 CA，覆盖可信证书成功、未知 CA 拒绝和主机名不匹配拒绝；同时检查 localhost 绕过及公网 IP 隧道。此验证使用本地测试服务，不代表故障电脑已升级或已完成注册。

本次本地验证通过：`cmake --build build -j 2`；`npm test`（15 项 CTest、37 个 Vitest 文件 / 400 项测试）；`npm run test:tls`（9 组 HTTPS / WSS 场景与 Access 回归）；`npm run typecheck`、`npm run lint:cpp`，以及修改的 TypeScript 文件 ESLint、该文件与用户手册 Prettier 和 `git diff --check`。TLS 专项因沙箱禁止监听本机 socket，在获准的沙箱外执行。尚未运行对应源码提交的 GitHub Actions、构建发布制品或部署到故障电脑。

下载单独发布脚本增加显式本地 Linux 构建入口；回归检查不访问 Actions、复用原 Worker / 网页、记录 CI 未验证并拒绝脏源码。发布包将使用 0.6.16，Windows 按用户要求保留原下载。

0.6.16 Linux 已按用户要求跳过 Actions 构建并发布，musl 专项、宿主 PTY 补测及线上归档校验通过；Windows 保持 0.6.15。源码、检查范围、摘要与限制见 [发布记录](RELEASE_0.6.16.md)。

## 2026-11-08 CW 本地缓存背压修复

`npm run test:cache` 使用真实 Chromium IndexedDB 事务，在缩小的全局 / 单作用域预算下填满不可回收记录，验证草稿、待确认输入、浏览位置与订阅状态仍可使用恢复预留，普通历史不能侵占预留；原有两页签原子记账、检查点回滚及命令保留回归同时通过。

构建网页后执行 `node node_modules/tsx/dist/cli.mjs tests/ui-stability.ts --cache-quota`，在 390 × 844 手机视口注入订阅分配检查点的 `QuotaExceededError` 事务中止，验证历史连接保持、在线分页及新消息渲染继续、输入可用。截图保存在忽略路径 `.local/ui-stability/cache-quota-mobile.png`。订阅、历史同步及命令交付 53 项单元测试和 TypeScript 检查通过；错误分类仍区分配额不足与订阅证明损坏，不确认未持久化内容。

完整 `npm test` 通过（15 项 CTest、37 个 Vitest 文件 / 403 项测试）；默认 `npm run test:ui` 的导航、既有行为与新增配额故障用例全部通过。网页构建、修改代码的 ESLint / Prettier、`git diff --check` 通过。新增配额 UI 用例也纳入默认 UI 测试入口。

这是本机 Chromium 的配额故障模拟，未在真实 iPhone / Safari 上验证，未提交或发布网页，也未变更 Agent 或远程任务。

后续已按用户明确要求跳过 Actions，以提交 `8fc8289` 本地构建发布主站网页；线上静态资源和 Worker 保留摘要核对通过，见 [缓存背压修复发布记录](BROWSER_CACHE_FIX_20261108.md)。

## 2026-11-08 会话归档与永久删除

新增 `npm run test:threads`（构建后运行），覆盖 CTest 的计划、分页目录、父子级联/独立 fork、项目边界、运行/未决状态、缺失接口、响应丢失、Agent 重启只读恢复、归档部分成功、SQLite 清理失败回滚；真实 Agent 的加密端点检查确认要求、角色/项目隔离、原请求回执、防重复执行和删除后拒绝续接。网页检查在 390 × 844 视口验证归档列表、取消归档、删除确认/取消、刷新不复现；截图位于忽略路径 `.local/ui-stability/threads-archived-mobile.png`、`threads-deleted-mobile.png`。

`npm run test:cache` 通过真实 Chromium IndexedDB 验证草稿/历史订阅/已确认原请求清理、未确认恢复证据保留、其他会话隔离和旧标签页写入拒绝；清理历史不会移除删除屏障。`npm test` 通过 16 项 CTest 与 37 个 Vitest 文件 / 404 项测试。`npm run test:threads:codex` 在独立临时 CODEX_HOME 用真实 Codex 0.166.0 验证归档移动 JSONL、恢复路径、永久删除文件和目录项，项目标记文件保留，并核对混合模型提供商目录；没有模型调用，也没有使用用户会话。

类型检查、协议生成一致性、原生/网页构建、格式检查和完整 `npm run test:ui` 均通过。未在真实 iPhone / Safari 验证，未执行 GitHub Actions 或生产部署。独立 Codex 客户端不受 CoC 锁控制，离线设备与备份不自动擦除；未知变更计划保留并占用有界容量。

后续功能源码 `91d3093` 的六项 Actions 门禁全部成功，CI 制品专项复测通过；主站网页 / Worker 和四平台 0.6.17 下载已发布并核对，Agent 按用户选择等待会话结束后更新，见 [会话管理发布记录](SESSION_MANAGEMENT_RELEASE_20261108.md)。

## 2026-11-09 CW 运行中缓存告警

`npm run test:cache` 通过真实 Chromium IndexedDB 回归，包括同一轮连续收到 650 条不同事件时全部落盘、检查点为 650，以及原有配额、事务原子性、跨标签页隔离和清理保留测试。`tests/ui-stability.ts --cache-quota` 分别注入打开会话时订阅检查点配额失败和对话进行中事件写入配额失败；验证明确满额提示、停止后续历史写入、继续在线刷新和显示事件、保持连接及任务发送。截图位于忽略路径 `.local/ui-stability/cache-quota-subscription-mobile.png` 与 `cache-quota-events-mobile.png`。

完整 `npm test` 通过（16 项 CTest、37 个 Vitest 文件 / 412 项测试）；类型检查、修改代码 ESLint / Prettier 与网页构建通过。未在真实 Safari 或用户浏览器上复现；实际故障原因由新的分类提示和具体存储错误进一步辨认。按用户要求跳过 GitHub Actions，主站网页已发布并完成线上资源核对，见 [发布记录](CW_HISTORY_CACHE_RUNTIME_FIX_20261109.md)。

## 2026-11-10：邮箱自助授权本地验证

新增平台管理员开关、SETTINGS KV 持久化、浏览器邮箱配对及按批准者确定 Agent 管理邮箱；旧主机不追溯绑定。37 个 Vitest 文件 / 418 项测试通过，其中 Access / 设备授权专项共 83 项。新增测试验证默认关闭、普通用户修改被拒、KV 重建恢复、无 KV / 无邮箱验证拒绝开启、伪造请求体邮箱与无邮箱 Service Token 被拒、终端码、原进程重复领取同一结果、跨邮箱 CLI 拒绝、申请到期 / 拒绝 / 主机撤销、管理员批准邮箱及本地配置不可覆盖。

TypeScript、变更文件 ESLint、网页生产构建和 Worker dry-run 通过，绑定包含 SETTINGS KV；20 项 cloud-deploy 测试通过，覆盖 r2 与生产 KV 隔离及仅更新 r2 网页时保留其原 namespace。真实 Chromium 的 `tests/browser-access.ts` 通过，覆盖管理员开关保存、首次配置引导、输入终端码配对、刷新后隐藏引导，同时保留邮箱恢复、管理员登录、中英登出与访客前缀回归。截图 `.local/browser-access/email-self-service-admin.png` 与 `email-self-service-setup.png` 保存在忽略目录；界面数据为合成身份。

以上为当前工作区的本地验证，未执行 Actions、发布 Worker、创建线上 KV 或开启线上自助授权；不代表 r2 已更新。r2 目前的原生下载仍需独立 Access 配置文件，公开测试发布时须同时准备可用的入口配置与用户下载说明。没有调用模型、修改生产授权或重启现有 Agent。

### 同日 r2 实际部署

用户随后明确要求跳过 Actions 直接部署。`a41a0a8` 已通过本地构建发布至 `r2.xlogic.cc`，独立 KV、健康、静态资源字节及权限拒绝检查通过，自助授权保持关闭；原生下载复用已验证的 0.6.18 快照。发布前旧 r2 Worker 已不存在，本轮新建独立授权存储，未恢复删除前的授权；主站及本机 Agent 保持。部署脚本的本地快照恢复新增专项通过，cloud-deploy 共 21 项。详见 [r2 发布记录](R2_DEPLOYMENT.md#2026-11-10邮箱自助授权与独立测试站恢复)，本次 `ciVerified=false`。

## 2026-11-10 网页 Zod CSP 告警

原始源码构建得到用户报告的同名资源 `index-BHq4trrn.js`。在 Bookworm 测试容器的真实 Chromium 中，新增 `securitypolicyviolation` 监听捕获到该文件第 2 行的 `blockedURI=eval`，回归按预期失败；Zod 捕获探测异常后，页面仍能通过加密端点夹具读取文档，说明该告警本身不等于会话握手失败。

网页入口先执行独立的 Zod `jitless` 配置模块，随后创建业务 schema。重新构建后，同一 `npm run test:markdown` 通过：启动及后续桌面 / 手机、公式与图表交互均无根页面 eval CSP 违规，加密端点读取正常。没有放宽 Worker CSP。类型检查、修改代码 ESLint / Prettier、`git diff --check` 与缓存预算 / 历史订阅 / 网页 API 的 39 项单元测试通过。

本次为本地验证，未执行完整原生测试、GitHub Actions 或生产部署；尚未在用户浏览器中确认关闭代理后的 WebSocket 失败原因。Cloudflare beacon 被 CSP 拦截与历史缓存预算满额分别处理，未修改统计配置或删除用户缓存、草稿、未确认任务。

## 2026-11-10 网页慢网络握手等待

按用户要求，将网页通道加密握手、会话控制握手从 15 秒延长至 30 秒，将通道业务请求从排队起算的总等待从 30 秒延长至 45 秒。网页构建、类型检查、修改代码 ESLint / Prettier、`git diff --check`、网页 API 与恢复调度的 17 项单元测试通过；重新构建后的 `npm run test:markdown` 通过真实 Chromium 的加密通道与页面交互回归。

这些检查验证正常连接未回归，没有模拟 15–30 秒网络延迟，不能据此确认用户直连链路已恢复稳定。本次未部署，线上网页仍须发布后才使用新时限。

## 2026-11-10：合并 GitHub 网页连接修复

将 GitHub `5f08ebe` 的慢网络握手与 Zod CSP 修复合入邮箱自助授权分支；保留双方更新日志、开发与用户说明及独立测试记录。网页入口首先导入 `zod-config.ts`，随后导入邮箱自助授权组件，确保 schema 创建之前启用无 JIT 配置；保留通道 / 控制握手 30 秒与业务请求总等待 45 秒。

合并工作区的 TypeScript、完整 lint、网页生产构建、37 个 Vitest 文件 / 418 项测试及 `git diff --check` 全部通过。真实 Chromium 的 `test:markdown` 验证加密端点读取、桌面 / 手机交互和无 eval CSP 违规；`tests/browser-access.ts` 验证邮箱恢复、管理员开关、首次配置引导、配对完成、双语登出和访客前缀。原始日志保存在忽略目录 `.local/github-merge-20261110/`。本轮未模拟额外慢网络或修改线上部署，线上版本仍以部署记录为准。
