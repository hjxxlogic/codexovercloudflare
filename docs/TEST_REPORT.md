# 测试说明

## 2026-11-06：r2 仅网页发布工具

`python3 tests/deploy-web.py` 覆盖原 Worker 执行代码完全匹配、代码不一致拒绝、额外执行模块拒绝、缺失入口拒绝，以及变量 / 原生变更选项拒绝。调试 source map 规范化不参与执行代码摘要比较。发布前后还会从 Cloudflare 实际读取执行模块核对，网页资源逐字节校验；5/5 检查通过，线上模块摘要、资源字节、Web 验收、临时凭据清理和隔离核对通过，见 [发布证据](assets/cw-observer-web/verified-preview.json)。

## 2026-11-06：CW 只读历史恢复

适配 master `9580dcb` 的修复与当前“继续对话”界面，新增首次只读、控制连接被 4009 替换后只读两项浏览器回归；检查返回页面补回新消息且不增加 attach / takeover 请求。修复前新增回归按预期失败，修复后导航专项通过，无浏览器异常；历史同步 / 订阅单元测试 20/20、Web 构建、TypeScript、受影响文件 ESLint / Prettier 通过。结果与边界见 [实施记录](CW_OBSERVER_HISTORY_FIX.md)。之后按用户“仅部署网页”要求已发布 r2，Worker 执行代码保持，见 [发布证据](assets/cw-observer-web/verified-preview.json)。

## 2026-11-06：0.6.13 继续对话

仅 Web UI 验证：覆盖连接正常时隐藏连接 / 接管操作、其他页面占用时的继续入口、转移确认取消 / 接受的实际请求数量、临时断线自动重试与提示恢复消失、closed / failed 的继续入口及 starting / closing 的等待状态。保留桌面 / 手机导航、草稿、文件预览及管理界面回归。构建、类型与受影响文件静态检查及准确结果见 [实施记录](CW_CONTINUE_0.6.13.md)。完整仓库、原生、模型任务与完整 CI 不在范围内。r2 线上 Web 验收、资源字节核对、临时凭据撤销与旧站 / 两个 Agent 隔离复核通过，见 [发布证据](assets/cw-continue-0.6.13/verified-preview.json)。

## 2026-11-06：0.6.12 顶栏、独立预览与消息复制

仅进行 Web UI 验证：导航专项通过，覆盖正常顶栏精简、离线浮动 / 恢复消失且对话尺寸不变、用户 / AI 原文复制、超过 13 万字符分页完整复制且不改变正文高度、浏览器 / 预览独立关闭、保留筛选、手机列表 / 预览切换。高级 Markdown 浏览器回归通过；发布前同时完成 Web 构建、类型及受影响文件静态检查。完整仓库、原生、模型调用与完整 CI 不在本次范围。准确结果见 [实施记录](CW_UI_0.6.12.md)。r2 线上 Web 验收、资源字节核对、临时凭据撤销和旧站 / 两个 Agent 隔离复核通过，见 [发布证据](assets/cw-ui-0.6.12/verified-preview.json)。

## 2026-11-06：0.6.11 Web 交互细节

Web 构建、类型检查、受影响代码 ESLint / Prettier、导航浏览器专项和高级 Markdown 检查通过；无浏览器异常。仅验证 Web UI：单行折叠、项目刷新 / 路径预填、设置图标文字、信息模态与焦点恢复、长预览 / 全屏工具栏、复制按需显示、长工具命令单行省略，并回归既有桌面 / 手机导航与 Markdown。准确检查结果及边界见 [0.6.11 实施记录](CW_UI_POLISH_0.6.11.md)。r2 线上 Web 验收、资源字节核对、临时凭证清理和旧站 / 两个 Agent 隔离复核通过，见 [发布证据](assets/cw-ui-polish-0.6.11/verified-preview.json)。

## 2026-11-05：0.6.10 三级导航与图标操作

Web 构建、类型检查、受影响代码静态检查、`npm run test:ui:navigation` 与 `npm run test:markdown` 通过。覆盖三级互斥展开、上级有效性、邮箱前缀、授权 / 新建项目表单与权限提示、主机切换清空下级、草稿 / Terminal 保留、桌面 / 手机、管理导航、工具提示关联及富文本。未执行完整仓库、原生、模型任务或完整 CI 测试；上线只做 Web UI 验证。详见 [0.6.10 实施记录](CW_NAVIGATION_0.6.10.md)。 r2 线上 Web 验收、资源字节核对、临时凭证清理与旧站 / 两个 Agent 隔离复核均通过，见 [发布证据](assets/cw-navigation-0.6.10/verified-preview.json)。

## 2026-11-05：0.6.9 Web UI 专项

统一左侧导航、设置页、五按钮和文件面板合并完成。Web 构建、类型检查、受影响文件静态检查、`npm run test:ui:navigation` 与 `npm run test:markdown` 通过。按用户要求不执行完整测试或原生测试，采用 r2 本地预览；完整 CI 未验证。具体覆盖、限制和截图见 [实施记录](CW_NAVIGATION_0.6.9.md)。

本文列出当前测试入口和验证边界，不把历史通过结果当作当前提交的检查结果。运行依赖与构建步骤见 [开发说明](DEVELOPMENT.md)，正式发布需检查准确提交的完整 Actions 运行。

2026-11-05 授权复核修复新增持续事件流、原 Agent 回复、缓冲顺序、真实撤权和输入/输出超限回归，并更新刷新交错及控制异常断言。本地 Vitest 505/505、类型检查及 Lint 通过；另运行原生 delivery 与 history retention 集成通过。opaque 分支两项问题及 master 的差异用隔离复现验证，具体边界见 [审查记录](AUTHORIZATION_REVIEW_2026-11-05.md)。包含修复的准确提交 `a1fc79f3a80e74ee8310739bd4d69934ab48e331` 已通过 [完整 Actions 门禁](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41961015104)，六个必需作业全部成功。云端字节与包摘要验证、线上准入边界检查、本机 Agent 空闲安装及 120 秒运行观察均通过；已登录生产浏览器验证的限制和完整部署证据见 [发布操作](RELEASE.md)。

2026-11-05 Happier 官方 Web 实测与第二轮改版：两个隔离真实模型会话覆盖多会话、工具 / 文件审批、长输出和复杂格式；自动回归仍使用模拟 Codex。当前 TypeScript、Lint、Web 构建、`test:opaque`、完整 `test:ui` 和 `test:markdown` 通过；完整 Terminal / E2E 46 项以及 r2 预览线上 `test:opaque` 已通过；准确提交 CI 尚在验证。新增紧凑标题、全高度侧栏和顶部操作不重叠断言。见 [官方 Web 对照](HAPPIER_WEB_COMPARISON_2026-11-05.md) 和 [实施记录](CW_HAPPIER_UI_PLAN.md)。

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

## 验证边界

测试使用独立配置和数据目录，不清理生产状态。截图、日志、测量与本机证据放在忽略的 `.local/`，可用 `COC_ARTIFACT_DIR` 指定浏览器证据目录。

确定性测试不能替代真实 Cloudflare Access 策略、跨网络长稳、平台账单、所有 Codex 版本兼容性或线上部署验证。逻辑预算不是 RSS、cgroup 或物理磁盘承诺。模型输出、真实文件变化和外部 Codex 来源需在对应环境单独验证。

CI 必须核对准确提交的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64 全部必要作业。运行中、已触发或仅部分通过不构成发布验证。部署后的运行身份与下载包身份分别核对，见 [发布操作](RELEASE.md)。

## 不透明中继实施记录（2026-11-04）

本轮在基于 `589c26b` 的独立 `docs/opaque-relay-architecture` worktree 实施，最终部署源码为 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`。具体用例和证据见 [不透明中继验收](OPAQUE_RELAY_TEST_PLAN.md)。原生/网页、Worker dry-run、静态检查与确定性集成分别记录，不把组件夹具通过写成完整公网通道通过。`test:delivery`、`test:runtime`、`test:terminal` 的内部引擎压力测试使用 `coc-agent-component`；生产通道由独立端点和端到端测试验证。

本机结果：13/13 CTest、35 文件 / 379 Vitest、完整 E2E 46 项通过（含 Terminal）；加密互通、真实 Codex TUI 初始化和原生/浏览器专项通过。构建与静态检查证据见验收记录。

该准确提交的 [完整 CI](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 六项必需作业全部成功，已使用 CI 制品部署到独立 r2。真实 Cloudflare、CI 原生 Agent 和 Chromium 的线上协议、浏览器任务及刷新恢复测试通过；模拟 Codex 未调用模型，邮箱登录和长稳未验证。来源摘要、截图及旧站 / Agent 隔离核对见 [r2 部署记录](R2_DEPLOYMENT.md)。

## master 合并验证（2026-11-05）

合入 master 至 `05a1f85` 的已提交改动。授权复核缓冲适配密文通道，控制事件串行处理，退休确认绕过暂停的数据；保留新架构的端点控制及 SQLite 版本 2。启动诊断、配置容错和固定重试采用 master 行为；Client 启动回归的模拟 Relay 复用原生密码互通夹具作为加密端点，Agent 重试回归使用 channel-register。

验证在独立 worktree、临时配置和数据目录进行，使用 `COC_NO_STARTUP_REPAIR=1` 禁止故障测试调用真实模型；启动诊断专项单独使用假 Codex。此合并不代表更新已部署的 r2 或旧站。

合并检查：原生构建、类型、lint / C++ 格式、Vitest 35 文件 / 381 项、原生 15 项（完整运行 14 项通过后单独修正并通过 Client 启动夹具）、配置管理、自动更新和实际计时重试通过。完整 E2E 发现故障注入恢复等待窗口短于新的 30 秒重试周期，已调整；在随后的 CW 界面实施中，包含 Terminal 的完整 46 项 E2E 最终全部通过，不将先前超时运行计为通过。合并专项日志为本机 `/tmp/opaque-master-*.log`，最终 E2E 为 `/tmp/cw-happier-e2e-complete.log`，未调用模型或部署。

## CW Happier 界面移植（2026-11-05）

计划、来源与实施过程见 [CW 界面记录](CW_HAPPIER_UI_PLAN.md)。本次产品差异仅在 `apps/web/`，复用原会话、消息、审批、文件及可靠传输，不引入新依赖。完整 MIT 许可随网页静态资源发布。

类型、ESLint / Prettier、网页构建和 Vitest 35 文件 / 381 项通过；英文词条专项 5 项单独复核通过。完整 `test:ui` 通过，包含桌面侧栏、手机抽屉搜索 / 焦点、选择当前会话不重复连接、主题、审批、文件 / Markdown、模型、草稿、身份隔离，以及新增 720px / 650px 分屏输入卡片不覆盖 Terminal 的断言。

`COC_NO_STARTUP_REPAIR=1 COC_TEST_TERMINAL=1 npm run test:e2e` 最终退出码 0，46 项全部通过，覆盖原生 CLI、真实 PTY 的输入输出 / 拖动 / 全屏 / 手机、会话历史与可靠传输、控制权、审批、文件上传断线恢复、双主机隔离及权限撤销。阅读区保留原有 65% 比例约束，新增标题计入与现有工作台工具栏一致的高度预算；去除输入卡片叠加留白，保持输入区在视口内。强制断网后的测试等待给固定 30 秒重试留足时间，原请求编号和去重断言保留。

`COC_NO_STARTUP_REPAIR=1 npm run test:opaque` 通过真实本地 Worker、原生 Agent 和 Chromium 的项目选择、提示词流式回复、刷新恢复及回复去重；该浏览器任务流程现也在本地模式执行。模拟 Codex 未调用模型。截图和结构化结果见 `docs/assets/cw-happier-ui/`；原始日志在 `/tmp/cw-happier-*.log`。未部署，未更改正在运行的 Agent 或旧站。

## 0.6.8 全站 Happier 与 r2 升级

本轮将共享主题覆盖登录 / 配对、管理九个面板、CW、文件预览、图表、Terminal 和下载页。管理桌面侧栏与手机 Tab 保留原有审批、撤销、排序和权限行为；同页 / 跨标签主题同步不重建会话或终端。实施过程见 [计划记录](CW_HAPPIER_UI_PLAN.md#全站实施记录)。

本地原生构建和 CTest 15/15、Vitest 35 文件 / 381 项、完整 E2E 46 项（包含 Terminal）通过；完整 UI 专项已通过九面板 × 深浅色 × 桌面 / 手机，以及跨标签同步和既有故障恢复。类型、lint、网页构建、部署工具与来源校验测试通过。合成数据截图和本地结果见 [验证记录](assets/happier-site-0.6.8/verification.json)；准确提交 CI、部署来源、下载摘要与线上结果写入 [r2 部署记录](R2_DEPLOYMENT.md)，此处本地结果不代替 CI 门禁。

用户授权的本地 r2 预览已通过真实 Cloudflare / Agent / Chromium 线上测试，覆盖加密业务与九个管理面板的桌面 / 手机深浅色。79 个静态资源字节一致；下载页规范地址修正后部署工具 18 项回归通过。独立用户测试 Agent 已连接，原 Agent / 旧站隔离断言均通过。[预览证据](assets/r2-deployment-0.6.8-2026-11-05/local-preview-verification.json) 标记 `ciVerified=false`，不将仍在运行的 Actions 视为成功。

CI 的真实计时账单 / 重试专项需要约 8 分 35 秒，主回归总预算提高至 45 分钟，所有用例与断言保留。CI 默认禁用会调用模型的自动启动修复；专门的假 Codex 修复夹具清除此标记后验证该功能。
