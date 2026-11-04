# 不透明中继设计测试与验收

对应 [精简架构设计](OPAQUE_RELAY_DESIGN.md)，基线 `589c26b`。仅覆盖现有功能和本次职责迁移，不新增设备配对、项目级 ACL 或授权票据体系。

## 状态与方法

已实现新架构并执行本机分层回归。下列用例通过生产端点集成、原生业务引擎组件和故障注入共同验证；组件测试不单独作为加密通道通过的证据。实现覆盖现有功能，未发布或切换线上实例。

每例使用独立配置、数据库与模拟 Codex。角色准备为平台 owner、Agent 管理员、普通 CLI、普通 Web、另一主机用户及已撤销用户。请求计数和副作用由模拟子进程、临时文件或目标 SQLite 核验，不能仅检查响应状态。业务测试不调用模型，不接触线上状态。

## 1. 设计审查结果

| 检查项       | 结论与实施约束                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 功能范围     | 架构功能对应表覆盖现有 CLI/Web、项目、历史、外部 Codex、文件、Terminal、配置及运维；登录和授权保持现有模型 |
| 权限与控制权 | Worker 保留授权，Agent 仲裁业务控制权；Agent 不信任业务正文自报身份，也不能自行扩大 Worker 权限            |
| 可见范围     | 登录、权限、主机名称、在线路由、唤醒与公开发布属于允许控制面；业务能力、版本详情、会话及配置必须加密       |
| 故障责任     | 中继重建允许断线；端点保存原请求和确认水位；传输成功不能替代业务成功                                       |
| 撤销竞态     | 端点退休确认是新增必要边界；确认与副作用派发串行，失效通知丢失仍须保留事件重试                             |
| 控制迁移     | 原 HostRelayDO 控制测试必须迁往 Agent；不得删除旧断言后仅测试通道转发                                      |
| 加密决策     | 原生 libsodium 与锁定 JS wrapper 实现 X25519 / secretstream；真实互操作及篡改、重放、错绑负向用例通过      |
| 状态切换     | 单 Agent 只有一个控制权来源；旧未决请求不换编号，新旧格式不兼容时明确拒绝并保留原状态                      |

通道协议、Agent 控制状态及 SQLite / DO 单向切换已落地；本机验收与正式发布所需的平台 CI 分别记录。

## 2. 通道、身份与权限

| ID  | 操作 / 故障注入                                | 必须断言                                                           | 现有覆盖与新增位置                                                         |
| --- | ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| A01 | 分别用现有配对、API Key、Access 邮箱建立连接   | 角色、主体、目标主机与有效期和原授权一致                           | 复用 `device-auth.test.ts`、`cloudflare-access.test.ts`；增加通道集成      |
| A02 | 跨主机凭据、自报 owner、复制其他连接身份       | Worker 拒绝准入或端点拒绝派发；副作用计数为零                      | `project-management.test.ts`；增加绑定检查                                 |
| A03 | 普通身份读取项目，再尝试修改项目或远程配置     | 列表可用，管理操作拒绝；管理员身份按现有规则成功                   | `project-management.test.ts`、`remote-configuration.test.ts`；迁入加密调用 |
| A04 | C++ ↔ C++、浏览器 ↔ C++，非 ASCII 和跨帧消息   | 双向内容一致；Worker 只见公开握手材料和密文                        | 新增通道互操作测试，必须使用真实两端实现                                   |
| A05 | 修改密文、交换目标连接、重复密文、复用断线前帧 | 解密/绑定失败或拒绝；无业务副作用及成功 ACK                        | 新增通道负向测试                                                           |
| A06 | 撤销凭据/API Key、退出或更改管理员邮箱         | 路由停止；端点确认退休后，旧连接及其未开始命令不能派发             | 复用 `device-auth.test.ts`、`relay-order.test.ts`，增加端点屏障断言        |
| A07 | 丢失撤销通知或端点确认，重建 Registry/Host     | 保留失效事件并重试；API 返回待确认；不能虚报生效或恢复旧连接       | 现有持久失效事件测试 + 新端点回执测试                                      |
| A08 | 活跃连接到期、关闭握手未完成仍发数据           | 到期拒绝；退休 socket 即使仍为 OPEN 也不能派发                     | 迁移 `relay-order.test.ts` 对应断言                                        |
| A09 | 上行断开、更换 Agent、旧连接消息迟到           | 停止旧连接新派发；新连接重新准入；已开始工作不伪装取消             | 通道及 Agent 集成                                                          |
| A10 | 权限存储故障发生在准入或稳定转发期间           | 新准入失败关闭；已绑定稳定帧不逐包查询授权；失效处理失败保留待确认 | 现有授权故障测试 + 通道查询计数                                            |

## 3. 控制权迁移

| ID  | 操作 / 故障注入                             | 必须断言                                                                  | 现有覆盖与新增位置                                       |
| --- | ------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| C01 | 多个 Client 同时争用同项目写资格            | Agent 最多授予一个；读订阅不占写资格                                      | 迁移 `relay-order.test.ts` 单项目并发写测试至原生/端到端 |
| C02 | 接管提交前后发送旧代际命令                  | 旧端不能越过新控制屏障；已 started 工作保留真实状态                       | 原生派发边界与接管测试                                   |
| C03 | 丢失 CONTROL_READY，重复同一原请求          | 返回同一控制结果，不重复增加 epoch                                        | 迁移现有确认丢失测试                                     |
| C04 | 普通重连、迟到 READY、旧恢复证明            | 重连不增加控制代际；旧确认不能激活新连接控制权                            | 迁移现有恢复与迟到确认测试                               |
| C05 | 控制提交前后 Agent 崩溃；另行重建 DO        | Agent 数据库恢复真实控制状态；DO 不保存会话租约、project-writer 或 ticket | 原生崩溃恢复 + DO 状态检查                               |
| C06 | 标签页竞争、Terminal/任务互斥、停止释放项目 | 单写与互斥保持；停止任务须核对真实退出；同 dataDir 第二 Agent 仍被拒绝    | 现有 Terminal、runtime、backup 测试                      |

迁移时保留原测试针对 pending 接管、关闭中连接、确认丢失和 Agent 更换的全部竞态断言；其执行位置变化不降低覆盖要求。

## 4. 可靠交付与资源

| ID  | 操作 / 故障注入                      | 必须断言                                                              | 现有入口                                                     |
| --- | ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| R01 | 请求、回复、结果 ACK 分别丢失和重复  | 沿原 requestId 恢复；相同副作用最多派发一次；ACK 在客户端保存后发生   | `test:delivery`、`test:operations`、原生 core 测试           |
| R02 | received、started、终态提交边界崩溃  | 已确认数据不丢；started 无可证结果时保持 RESULT_UNKNOWN；不创建新意图 | 原生 core/operations 测试与故障注入                          |
| R03 | 清理正文后重放原请求，改变同 ID 内容 | 过期或内容冲突明确拒绝，不重新执行                                    | retention、operations 与 history 测试                        |
| R04 | DO 重建、路由映射丢失、连续重连      | 允许关闭并重建通道；使用端点水位恢复，不要求云端回放                  | `relay-order.test.ts`、`test:delivery`                       |
| R05 | 大文件与 Terminal、取消、恢复并发    | 加密开销计入上限；控制消息可前进；内存队列、信用和存储有界            | `test:runtime`、`test:terminal`、uploads 测试 + 加密通道负载 |
| R06 | 零字节洪泛、队列满、磁盘/事务失败    | 条数/字节预算都生效；不能静默丢掉流中间字节继续运行；不虚报持久成功   | 现有 relay/runtime_budget 测试 + 通道关闭断言                |

## 5. 现有功能回归

功能组在生产端点集成中验证接入，在组件测试中保留细粒度故障和预算断言。`coc-agent-component` 是 BUILD_TESTING 专用内部引擎入口，不安装、不打包；它不证明完整通道接入，须与下列端点测试合看。

| ID  | 流程                                        | 必须保留的行为                                                            | 测试入口                                                                             |
| --- | ------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| F01 | CLI RPC/TUI、网页任务、模型选择、审批、取消 | RPC 允许列表、审批主体与版本、拒绝/允许、退出及未知状态                   | `test:e2e`、`test:native`、external approvals 测试                                   |
| F02 | 项目和目录管理                              | 普通/管理身份隔离，登记 revision，目录边界和请求去重                      | `test:projects`、`test:projects:e2e`                                                 |
| F03 | 邮箱会话列表、续接和历史读取                | 按 Worker 绑定的真实用户过滤，跨邮箱隔离，游标及正文校验                  | mailbox、history 测试及浏览器 E2E                                                    |
| F04 | 外部 Codex 观察、入队和审批                 | 默认关闭项不被打开，溢出不隐式批准，原来源校验保留                        | external-codex / external-approvals 测试                                             |
| F05 | 文件树、预览、上传和下载                    | 路径校验、分块摘要、版本冲突和原请求恢复                                  | `test:e2e`、`test:uploads:web`、native uploads                                       |
| F06 | Linux Terminal                              | 隔离、seq/offset、渲染确认、gap、背压、未知按键不重放                     | `test:terminal`、`test:terminal:e2e`                                                 |
| F07 | Agent 与在线 CLI 的配置替换和重启           | owner 权限、目标进程绑定、原文字节、冲突、回执及至多一次重启              | `test:configuration`、remote-config 原生测试                                         |
| F08 | 唤醒、发布、更新和工作台                    | 原权限、公开制品检查、空闲安装、页面交互与缓存恢复                        | `test:wake`、`test:update`、`test:release`、`test:ui`、`test:cache`、`test:markdown` |
| F09 | 代理、TLS 与平台行为                        | 原生代理与 TLS 校验，Linux/Windows 支持边界不退化；CLI 管理不增加后台进程 | `test:tls`、proxy 原生测试、现有平台 CI                                              |

真实 Codex 协议测试与模拟 Codex 测试分开。`test:task` 是调用模型的额外验证，不作为本次确定性验收前置；真实 TUI 所需 Codex/workerd 不可用必须报告未执行，不能计为通过。

## 6. 不可见性与切换

| ID  | 操作 / 故障注入                                                         | 必须断言                                                                                                              |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| V01 | 为提示词、路径、会话 ID、配置、文件、Terminal、业务错误放入独立敏感标记 | 从 Worker 入口/出口解码所有可见封装、检查内存可见数据、DO/attachment/日志；只允许密文，不出现标记、明文语义或解密密钥 |
| V02 | 检查路由、schema 依赖、DO 记录及通知                                    | 权限/运维字段明确列入允许清单；Worker 无业务方法分发、会话控制状态或请求/结果关联；静态检查只作辅助，不能替代 V01     |
| V03 | 保持 Worker 不变，新增一个使用既有权限的端点测试方法                    | 两端调用成功，Worker 无需修改或部署；测试方法不进入产品接口                                                           |
| M01 | 单 Agent 切换，保留配置/凭据/历史，存在未决原请求                       | 切换前核对待办；新旧控制来源互斥；不换编号自动重做；不静默降级明文                                                    |
| M02 | 旧客户端接入、旧二进制读取不兼容状态、切换后回退                        | 明确拒绝并保持数据；回退不重复已执行请求，不回退拒绝屏障；异常可通过备份核对                                          |

V01 必须涵盖上表 F01–F07 的请求、回复、错误和通知。简单扫描二进制密文是否包含字符串不足以证明安全；同时验证加密实现真实互操作、密钥只在端点以及 A05 的负向行为。

## 7. 执行与记录

顺序：通道与身份 A 组 → Agent 控制 C 组 → 可靠性 R 组 → 功能 F 组 → 可见性与切换 V/M 组。保留每例的 ID、源码提交、环境、运行入口、结果和证据路径。功能回归需在新路由启用时执行；旧路由测试仅作迁移前基线。

正式验收要求所有适用用例通过，缺少依赖记为未执行，出现预期外跳过记为未完成。CI 需核对该精确提交的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 必要作业。实际部署另行记录，不由本测试设计触发。

迁移前 Vitest 基线为 35 文件 / 492 测试，日志 `/tmp/opaque-relay-baseline-vitest.log`。旧 Worker 业务分发测试随职责移除，改由原生端点测试和新 Worker 密文用例覆盖；当前 Vitest 为 35 文件 / 379 测试，数量不可直接比较覆盖程度。

### 本机证据（2026-11-04）

初始本机检查使用基线 `589c26b` 加本 worktree 更改；最终部署源码为 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`。Linux x86_64、C++17 Debug、Node 22.23.4、真实本地 workerd / Chromium；测试配置、凭据和数据库全部隔离，未调用模型。下列 `/tmp/opaque-*.log` 为本机运行证据，不随源码提交，也不充当平台 CI 结果。

| 用例     | 实际入口与证据                                                                                                                                                             | 验证范围                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A01–A03  | Vitest、`native-endpoint`、`native-projects.ts`、`projects-e2e.ts`；`opaque-native-projects.log` / `opaque-projects-e2e.log`                                               | 原授权、角色/主机绑定、普通访问与管理权限                                                                                               |
| A04–A05  | `secure-channel.test.ts`、`native-secure-channel`、`opaque-e2e.ts`                                                                                                         | 真实 C++/JS 密码互通，UTF-8 分片、篡改/重放/错绑关闭                                                                                    |
| A06–A10  | `relay-order.test.ts`、`device-auth.test.ts`、`native-endpoint`                                                                                                            | 退休、未注册上行直接关闭、降权确认、无关连接保留、通配退休、精确确认、DO 重建后重试、到期和稳定帧零授权查询                             |
| C01–C06  | `native-endpoint`、完整 E2E、native core/terminal、`state-backup.py`                                                                                                       | 一次性 ticket、相同 claim 重试、代次递增、接管隔离、项目单写及断线交接、退出及目录锁                                                    |
| R01–R03  | `native-operations.ts`、`native-cli-operations.ts`、`native-history-recovery.ts --retention`；`opaque-operations.log` / `opaque-cli-operations.log` / `opaque-history.log` | 生产端点原意图、丢回包、确认丢失、崩溃未知、保留/回源与去重                                                                             |
| R04–R06  | relay-order、native core/runtime、`native-delivery.ts`、`native-runtime-scopes.ts`、browser uploads                                                                        | 连接重建、双预算、512 排队/128 审批、精确取消、磁盘失败与 20 MiB 上传恢复；内部引擎压力使用组件程序                                     |
| F02、F07 | projects 两组、`native-configuration.ts`；`opaque-configuration.log`                                                                                                       | 真实 Agent/CLI 的项目管理、配置读取/替换、回执去重和进程重启                                                                            |
| F03–F05  | 完整 E2E、history、native core、`browser-uploads.ts`                                                                                                                       | 外部 Codex/审批、邮箱隔离、历史、路径和文件校验                                                                                         |
| F08      | `native-wake.ts`、`ui-wake.ts`、`native-update.py`、`release-provenance.py`、UI/cache/rendering                                                                            | 唤醒、更新、公开制品、页面与缓存；更新制品为隔离合成物                                                                                  |
| F09      | `native-tls.ts`、`native-access.ts`、browser-access / guest-access                                                                                                         | TLS 拒绝与代理、Access/访客前缀、真实 Worker 通道撤销；Windows 已由完整 CI 验证                                                         |
| V01–V03  | relay-order 真实密码双向敏感标记用例 + opaque E2E；Worker 仅依赖 admission schema                                                                                          | 提示词、会话、路径、文件、Terminal、配置、错误及通知不进入中继可见封装/附件/存储/日志参数；新增测试方法无需 Worker 分发                 |
| M01–M02  | native-store-compaction、native operations、relay-order、backup/login；`opaque-old-binary.log`                                                                             | 完整 0/1 库保留记录后标记 2、未知/残缺库不变、准确基线 Agent 拒绝版本 2 且数据库字节不变、旧业务入口 426、DO 清理旧业务状态保留唤醒冷却 |

`test:task` 不属于本轮确定性验收。真实 TUI、完整 E2E 和 Terminal 的最终结果如下，未用 app-server 初始化替代 TUI 验证。sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 已由最终完整 CI 验证；生产数据升级 / 回退演练未执行。

### 最终本机结果

| 检查             | 结果                                                                                      | 证据                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTest / Vitest   | 13/13 原生用例、35 文件 / 379 测试通过                                                    | `/tmp/opaque-final-test.log`；新增控制持久化、单写交接与恢复序号断言另见 `/tmp/opaque-endpoint.log`                                                                                                                                 |
| 完整生产通道 E2E | 46 项通过，启用 `COC_TEST_TERMINAL=1`；真实 Worker、原生 Agent/CLI、Chromium 和模拟 Codex | `/tmp/opaque-full-e2e.log`；`.local/browser-session-stress.json`                                                                                                                                                                    |
| 加密通道专项     | C++/浏览器互通、权限、控制、原请求去重、Unicode 文件和私有目录通过                        | `/tmp/opaque-e2e.log`、`/tmp/opaque-e2e-detail.log`                                                                                                                                                                                 |
| 真实 Codex       | app-server 协议和真实原生 TUI 初始化通过；未提交提示词                                    | `/tmp/opaque-real-codex.log`、`/tmp/opaque-real-tui.log`                                                                                                                                                                            |
| 原生专项         | TLS/Access、唤醒、按需通讯、项目、原请求、历史、配置、传输、运行预算和 Terminal 通过      | 前表对应的 `/tmp/opaque-*.log`                                                                                                                                                                                                      |
| 浏览器专项       | UI、Markdown、缓存、上传、原请求、按需通讯、Access/访客、唤醒通过                         | `/tmp/opaque-ui.log`、`opaque-rendering.log`、`opaque-cache.log`、`opaque-browser-uploads.log`、`opaque-browser-operations.log`、`opaque-browser-demand.log`、`opaque-browser-access.log`、`opaque-guest.log`、`opaque-ui-wake.log` |
| 构建及静态检查   | 原生、网页、Worker dry-run、TypeScript、ESLint/Prettier、clang-format、协议生成一致性通过 | `/tmp/opaque-build.log`、`opaque-web-build.log`、`opaque-worker-build.log`、`opaque-typecheck.log`、`opaque-lint.log`、`opaque-cpp-lint.log`、`opaque-protocol.log`                                                                 |

真实 TUI 使用本机 Codex `0.166.0`，已完成账户读取、模型列表和 `thread/start`；`command/exec`、`thread/turns/list` 继续被现有 RPC 允许列表拒绝，不为测试扩大权限。`0.164.0` 仍为项目文档的兼容基线。

生产通道故障代理只观察密文与文件落盘证据：浏览器命令先写入本地待办，再中断连接；上传首块已落盘后丢失加密回包，暂停并重开面板后按原意图恢复。精确业务帧的丢失、重复、预算和崩溃边界仍由原生端点/内部引擎测试及独立浏览器上传测试覆盖。

最终提交已完成全部必要 CI 作业，并使用验证制品部署到独立 r2；未调用模型。线上长稳和生产数据升级 / 回退未执行，不计为通过。

### r2 发布门禁发现

首轮 CI `b963241` 的 Ubuntu 20.04、Debian 12、musl 与 sanitizers 通过，Windows 12 项 CTest 通过；Windows 登录测试因 Python SQLite context manager 仅提交事务而未关闭连接，删除临时库时出现 WinError 32。测试现显式关闭连接，保留数据库不变性断言。

主回归的文件中断场景中，上传通道可能先于聊天控制通道恢复，页面保留预期的 `HOST_OFFLINE` 提示。测试现等待浏览器聊天恢复，关闭该明确的故障注入提示后测量正常移动端布局，保持原有空间和溢出断言，不隐藏其他错误。

连续注入断线时，下一次背景密文回复可能在浏览器提交表单前触发关闭。测试现先暂停密文回复，确认浏览器已持久化原请求并清空已提交草稿，再关闭链路；保留真实恢复和任务去重断言，不依赖密文承载哪一种业务消息。

首轮整体未通过，未用于部署；后继修复 `a61423f` 已重新完成全部必要 CI。独立 r2 的目标、首次部署与线上测试命令见 [发布操作](RELEASE.md#独立-r2-测试站)。

修复后本地启用 Terminal 的完整生产通道 E2E 46 项通过，日志 `/tmp/r2-fixed-e2e-3.log`；类型与 lint 检查通过。[最终 CI](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 包含 Windows 在内的六项必需作业全部成功。

### r2 线上验证

使用准确提交 `a61423f` 的 CI Worker、网页及 musl Agent，在真实 Cloudflare 上验证加密业务、权限、原请求去重、控制接管、文件和历史，以及浏览器项目选择、任务流式回复和刷新恢复。隔离测试使用模拟 Codex，不调用模型；Service Auth 与 CoC 访客授权不替代邮箱登录验证。临时 Agent 和测试授权已清理，旧站与本机 Agent 在实际发布前后身份保持一致。来源、摘要、截图和具体限制见 [r2 部署记录](R2_DEPLOYMENT.md)。
