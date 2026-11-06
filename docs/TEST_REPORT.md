# 测试说明

本文列出当前测试入口和验证边界，不把历史通过结果当作当前提交的检查结果。运行依赖与构建步骤见 [开发说明](DEVELOPMENT.md)，正式发布需检查准确提交的完整 Actions 运行。

2026-11-05 授权复核修复新增持续事件流、原 Agent 回复、缓冲顺序、真实撤权和输入/输出超限回归，并更新刷新交错及控制异常断言。本地 Vitest 505/505、类型检查及 Lint 通过；另运行原生 delivery 与 history retention 集成通过。opaque 分支两项问题及 master 的差异用隔离复现验证，具体边界见 [审查记录](AUTHORIZATION_REVIEW_2026-11-05.md)。包含修复的准确提交 `a1fc79f3a80e74ee8310739bd4d69934ab48e331` 已通过 [完整 Actions 门禁](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41961015104)，六个必需作业全部成功。云端字节与包摘要验证、线上准入边界检查、本机 Agent 空闲安装及 120 秒运行观察均通过；已登录生产浏览器验证的限制和完整部署证据见 [发布操作](RELEASE.md)。

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

| 命令                                                      | 验证目标                                     |
| --------------------------------------------------------- | -------------------------------------------- |
| `npm run test:e2e`                                        | 完整原生、Relay、浏览器会话、审批和文件流程  |
| `npm run test:tls`                                        | 原生 TLS 与 Access 入口                      |
| `npm run test:access:web`                                 | 浏览器 Access 与访客授权                     |
| `npm run test:wake`                                       | 离线唤醒与 UI                                |
| `npm run test:ui` / `npm run test:cache`                  | 工作台交互、布局、缓存与恢复                 |
| `npm run test:projects` / `npm run test:projects:e2e`     | 多项目、管理身份、目录边界与浏览器流程       |
| `npm run test:delivery`                                   | 可靠传输、丢包重连、历史恢复与保留策略       |
| `npm run test:operations` / `npm run test:operations:web` | 原请求持久化、去重、结果未知和恢复           |
| `npm run test:configuration`                              | 远程配置替换、冲突与重启回执                 |
| `npm run test:uploads:web`                                | 上传完整意图与恢复                           |
| `npm run test:runtime`                                    | 进程、队列、审批、RPC 资源隔离               |
| `npm run test:markdown`                                   | 公式、图表沙箱、流式解析、危险内容和手机视口 |
| `npm run test:terminal`                                   | 原生 PTY、控制证明、输入去重与项目互斥       |
| `npm run test:terminal:e2e`                               | Chromium → Worker → Agent → 隔离 PTY         |
| `npm run test:backup`                                     | SQLite 一致备份、恢复与实例锁                |
| `npm run test:release`                                    | 发行来源和部署工具拒绝路径                   |
| `npm run test:update`                                     | 当前自动更新、校验失败拒绝                   |
| `npm run test:billing` / `npm run test:billing:web`       | 按需通讯、刷新与通知行为                     |
| `npm run test:retry`                                      | Agent 固定 30 秒重试、初始化恢复与显式停止   |

Worker 授权专项：`npx vitest run tests/relay-order.test.ts tests/device-auth.test.ts`。覆盖握手后的双向零授权查询、DO 重建、退休连接、授权变更、到期及持久失效事件重试。稳定数据转发不能依赖短时缓存命中；控制面授权仍需完整检查。

Agent 重试专项使用真实原生进程、Socket 与实际计时，不加速重试定时器。`test:retry` 覆盖连续 HTTP 401 / 403、协议不匹配、4001、非法配置、Codex 不可用、状态锁占用、配置修复和锁释放后的自动恢复，以及在重连 / 初始化等待中明确停止后不再尝试。`test:billing` 同时验证空闲零业务轮询、Pong 超时后固定延迟与连续连接失败后的恢复，并包含该重试专项。

2026-11-04 授权竞态回归新增 7 项：有效 Agent 在两轮刷新不同返回顺序下保持连接，过期成功或拒绝结果均重新核验；当前撤权即使随后收到旧成功也保持退休；状态查询遇到授权刷新不会误踢 Agent。校验期间禁止转发，最新授权通过后恢复。修复前新增项中 5 项失败、2 项通过；修复后本地 Vitest 499/499、类型检查、Lint 和 Worker dry-run 通过，未调用模型或部署。线上状态、隔离复现及验证边界见 [事故记录](INCIDENT-2026-11-04.md)。

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

2026-11-05 启动失败 Codex 修复：`cmake --build build -j2` 通过；完整 CTest 在允许本机 socket 的环境中 12/12 通过（156.74 秒）。沙箱内项目/core 测试因 socket `Operation not permitted` 失败，已在沙箱外重跑通过。新增 `native-startup-repair` 使用假 Codex 验证 Client 配置失败、提示词不带配置内容、标准输入隔离、禁用开关、help 不触发，以及 Agent 跨重试周期仅启动一次。不执行真实模型修复；未在 Windows 实机验证，也未部署。

2026-11-05 Client 会话启动诊断补齐：`cmake --build build -j2` 通过；`ctest --test-dir build -R 'startup-repair|native-core' --output-on-failure` 3/3 通过（69.06 秒）。新增回环 HTTP/WebSocket + 假 Codex 回归覆盖 attach/connect 版本校验失败、校验失败不发远端请求、禁用开关、连接拒绝、缓存路径故障、TUI 提前异常退出（含 127）、正常退出、握手后但 initialized 前失败、initialized 后运行失败，以及 connect 参数错误；提示词不含凭据和会话 ticket。增加远端请求断言后单独重跑新增测试通过。测试需要本机 socket，沙箱拒绝后在沙箱外运行；未调用真实模型，未在 Windows 实机验证，未部署。

2026-11-06 CW 跨设备只读历史恢复：`npm run test:ui` 完整通过，新增模拟控制连接被其他设备接管（4009）、历史连接 OPEN 但不送达更新，返回页面后通过 HTTP 补回最新消息且 attach 次数不增加。`npx vitest run tests/history-sync.test.ts tests/history-subscription.test.ts` 20/20 通过；`npm run typecheck`、`npm run build:web`、受影响 TS 文件 ESLint 和 `git diff --check` 通过。UI 测试需本机 HTTP/WebSocket 与 Chromium，在沙箱外执行；首次新增断言存在重复定位器及恢复步骤面板定位问题，修正后完整重跑通过。未部署，未进行真实跨设备长稳验证。
