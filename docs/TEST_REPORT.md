# 测试说明

本文列出当前入口与验证边界；本次集成结果见文末。历史预览不代表当前提交或线上部署，准确来源见 [r2 历史发布记录](R2_DEPLOYMENT.md)。

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

输入固定为 master `7c344413607becd70444341882951844a6e72dbd` 与源 `f2de6f8ccea342575ce99b8c852f893f938285c3`。合并提交 `0de34e4` 保留双方父提交，后续修正继续在 `integrate/opaque-relay`；源码版本统一为 0.6.14。本次没有部署、下载发布、Agent 安装或 tag。

| 本机检查             | 实际结果                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖、构建与静态检查 | npm ci、完整 npm run build（原生 / Web / Worker dry-run）、typecheck、lint、lint:cpp、protocol generate/check 通过                                                              |
| 基础与 sanitizer     | 15 项 CTest、36 个 Vitest 文件 / 390 项测试通过；独立 ASan/UBSan 构建的 15 项 CTest 通过                                                                                        |
| 加密、队列与历史     | test:opaque、test:queue、delivery / retention、operations、configuration、projects、runtime 通过；真实加密通道与浏览器覆盖队列去重、取消、立即执行、刷新恢复和观察历史          |
| 认证及资源           | TLS / Access、browser-access / guest-access、真实计时 billing、billing:web、wake 通过                                                                                           |
| Web 与真实协议       | 默认 test:ui 和 navigation、新增恢复行为、markdown/cache、projects:e2e、operations:web、uploads:web、native Terminal、native-login、真实 Codex 无模型初始化与 native smoke 通过 |
| 工具                 | release / update / backup、agent-deploy 19 项、cloud-deploy、deploy-web、Access 工具 4 项、CI 输出工具通过；均为隔离测试，没有执行生产 apply                                    |
| 完整 PTY E2E         | 已通过原生协议与 CLI、任务 / 模型 / 去重、TUI 断线恢复、真实授权、3 / 5 浏览器并发单写与交接；后半段 Terminal / 文件 / 撤权仍在完成最终重跑                                     |

`test:ui` 默认联合当前导航和行为回归：快照超时恢复、400/500 不清登录或草稿、语言持久化、模型选择、未知提交结果、0/1/3/10 审批和丢回包后不重复发送。`--navigation` 只运行导航，`--behavior` 可单独复现行为；`--legacy-layout` 保留旧布局供历史复现。队列 UI 由真实加密 `test:opaque` 验证。当前桌面与手机截图见 [界面说明](CW_HAPPIER_UI_PLAN.md)。

旧数据库演练使用准确旧提交 `666d1af` 编译其原 Store / Projects，创建含会话、队列、历史、回执与项目登记的 SQLite 0/1。新 Store / Agent 使用原配置、凭据和 dataDir 连续启动两次；旧项目登记逐字节不变，旧程序拒绝升级后的版本 2。SQLite backup API 验证包含已提交 WAL；备份写入失败保留旧版本并可重试，子进程文件大小限制分别模拟备份写入不足、备份已完成后的迁移 WAL 写入失败；两次失败后均可由旧程序验证原记录及旧版本，再由新 Agent 成功重试。入口为 `python3 tests/legacy-upgrade.py --legacy-source <隔离旧源码> --agent build/coc-agent`，CI 固定 checkout 旧提交；版本探测使用隔离模拟程序，不依赖系统安装 Codex。

自动更新补充演练 `COC_LEGACY_FIXTURE=.local/legacy-source/build/coc-legacy-upgrade python3 tests/native-update.py --automatic --busy` 通过：公开 Agent 的空闲更新保留旧配置、项目与账本；组件 Agent 注入内部控制，验证已准备的更新等待活动会话结束后才安装。模拟候选 ELF 只记录重启，不冒充实际新版业务运行；实际 CI Agent 包另作隔离启动验收。CI 固定运行完整自动 / 忙时组合。

DO fixture 覆盖多页事务备份、批次提交后中断与重启、同实例重试、重复迁移、wakeUntil 持久化、活动旧 lease / 待决控制预留 / 未完成权限操作 / 未知未来版本失败关闭。Registry 身份授权保留原结构。发布时仍需确认线上未决状态、导出快照及验证实际对象；本次没有生产副本或在线迁移证据。

中间失败如实保留：`0de34e4` 的 [Actions 42151853443](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42151853443) 因格式及 sanitizer CONFIG_BUSY 失败；锁处理中补齐 EINTR 重试与显式解锁后，`0ecf0b4` 的 [Actions 42154302199](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42154302199) 五个平台 / sanitizer 作业全部成功，regression 在加密浏览器的尺寸切换导航竞态失败。后者已修正并由本机 test:opaque 重跑通过。`15a705d` 与 `0d71c41` 的 regression 暴露升级演练依赖 CI 未安装的 Codex，现已改为隔离版本探测并在本机重跑通过。`adfd2ed` 的 sanitizer 日志显示 CTest 零失败（14 项通过，native-terminal 因该作业未提供隔离工具而跳过；真实 PTY 在 regression 和本机独立验证），但依赖安装耗时约 11 分钟导致作业超过 20 分钟总时限而被取消；将作业时限调为 45 分钟，保留全部检查及断言，取消仍不计为通过。中间提交和运行中作业均不作为最终门禁。

`a57a160` 的完整本机 PTY E2E 通过，CI 五项平台 / sanitizer 成功，但综合回归在三浏览器的只读就绪等待失败。现场截图与角色记录显示一写两读均已建立；旧测试按全页文本匹配，与隐藏的上下文头部重复文本发生严格定位竞态。就绪判断现限定实际只读提示区域，保留启用发送、一写多读、审批、刷新、交接及关闭断言。本机后续重跑通过 3 / 5 浏览器交接，并暴露聊天重连提示遮挡手机文件面板关闭按钮；聊天区域建立独立叠放上下文，保留实际点击关闭断言。

本机矩阵与重跑日志保存在忽略的 `.local/opaque-merge/`，截图原件位于 `.local/ui-stability/`、`.local/screenshots/`；不提交配置、数据库或凭据。最终准确提交的 CI、制品摘要与合入结果完成后补录。未执行生产变更、真实线上迁移、外网长稳或真实用户业务模型任务。一次本机补充更新演练因旧 fixture 主机身份不匹配而意外触发启动修复模型；该子进程只检查临时状态和公开下载索引后随演练结束，未部署，已修正身份并在测试内部固定禁用启动修复，后续重跑通过。
