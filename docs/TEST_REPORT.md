# 测试报告

[文档索引](README.md) · [开发与复现命令](DEVELOPMENT.md) · [发布记录](DEPLOYMENT_STATUS.md)

0.6.0 源码 `4b164c6` 已通过下述本机回归及全部必需 CI，云端与四平台下载包已发布。现场原生服务未自动更新；准确制品与线上验证见 [发布记录](DEPLOYMENT_STATUS.md)。

## CW 工作台本机验收 · 2026-11-02

分支 `feat/cw-workbench`，起点 `3da79b5`；本条覆盖该 worktree 的实现，不表示已发布或已通过全部跨平台 Actions。详细功能、限制、截图和复现见 [CW 工作台实施记录](CW_WORKBENCH.md)。

本地 master 合并验证：以 `ec7acc7` 为目标合并功能提交 `a17df59`，无冲突，保留缓存回收与 Agent 重连修复。合并后 typecheck、lint、lint:cpp、protocol:check、网页构建通过；33 文件 / 476 项 Vitest、真实浏览器缓存恢复及高级 Markdown 专项通过。该合并未触发推送或部署。

| 检查               | 结果                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生构建           | CMake Release 构建通过；Linux 默认关闭及显式启用两种路径可用                                                                                                                                    |
| 核心测试           | 10 项 CTest；32 文件 / 470 项 Vitest 通过                                                                                                                                                       |
| 类型及静态检查     | typecheck、ESLint/Prettier、C++ 格式和 protocol:check 通过                                                                                                                                      |
| 网页 / Worker 构建 | build:web、Wrangler deploy --dry-run 通过；未发布                                                                                                                                               |
| 终端专项           | 真实 Linux PTY / bubblewrap 的项目隔离、符号链接逃逸拒绝、重复输入无副作用、缩放、Ctrl+C、退出码、输出环截断、会话清理通过；实际 Agent 校验原操作创建、控制代次、项目互斥和 detach 后旧输入拒绝 |
| 高级 Markdown      | Chromium 真实渲染公式/图表、脚注和局部锚点、提示块、源码回退、危险链接/HTML 不执行、外部图片不请求、390 px 宽度通过                                                                             |
| 整页 UI            | 工作台主题/文件树/预览/引用/输出，快捷面板与键盘焦点、局部导出、通知权限拒绝，以及原会话、分页、审批、只读、离线、中英文及移动回归通过                                                          |
| DO / D1 完整集成   | 两套均通过，包含真实 Chromium → Worker → Agent → PTY 输入/输出/显式关闭、桌面无输入框重叠及 390×480 终端检查                                                                                    |
| 可靠操作 / 上传    | 浏览器操作锁、持久化先于发送、页面关闭/丢失 ACK 恢复通过；真实 IndexedDB 重启和 20 MiB 上传恢复、摘要、清理隔离、背压通过                                                                       |

补充原生配置回归：`python3 tests/native-login.py` 的 7 项测试通过，确认新增 `terminal.enabled` 默认关闭并保留显式配置；`npm run test:configuration` 的完整替换、备份、Agent/CLI 重启、重复请求和离线处理通过。

DO / D1 最后一轮均报告 `All local end-to-end checks passed`。随后仅补充工具栏横向表单样式的定向 UI 检查；相应最终结果见实施记录。终端和工作台截图均来自合成临时项目，没有现场凭据。

尚未运行新源码的完整跨平台 Actions、Windows 隔离终端、长会话 p95/内存基准或所有崩溃写入时序注入。已有 `native-terminal` 在工具缺失的平台允许 skip，本机安装 bubblewrap 并实际运行通过；不以 skip 宣称真实终端验收通过。未部署或重启现场任务。

## 历史优化最终本机回归 · 2026-11-02

本轮开发源码的本机无模型调用回归已完成，失败项修复并定向复测通过。下方早期记录按发生时间保留，不代表最终未完成状态；本结论不表示新源码已通过跨平台 CI 或部署到线上。

| 检查范围                                     | 最终结果                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 全构建、类型、lint、C++ 格式、协议生成一致性 | 通过；最后 CLI/脚本修复后重跑类型及两类 lint                                                           |
| 核心                                         | 9 项 CTest；28 个文件、449 项 Vitest 通过                                                              |
| Sanitizers                                   | 9 项 CTest 全通过，271.50 秒；后续 reader 修复重新编译 sanitizer Agent                                 |
| 原生集成                                     | TLS/Access、计费/长时重试、项目、交付、历史恢复/退休、操作、配置、运行时、唤醒全部通过                 |
| 浏览器与 Worker                              | DO/D1 两套完整 E2E、真实 Chromium 缓存、计费、Access、项目、操作、上传、D1 迁移及整页 UI 通过          |
| 真实 Codex                                   | 协议测试与 0.166.0 TUI initialize/thread/start 成功；未发送模型任务                                    |
| 维护工具                                     | 登录、Agent/云部署、Access 工具、CI 包装、备份、发行及更新测试通过                                     |
| 历史来源验收                                 | 新真实只读 Codex reader 恢复 1421/1421 原引用；真实 Agent 强杀重启、定时退休、引用过期及版本化缺口通过 |

回归额外修复 CLI 可靠请求在 HOST_OFFLINE 后遗漏已配置唤醒：原请求及结果确认共用一次唤醒标志，继续使用落盘的原身份。`test:wake` 验证唤醒和重试身份，`native-cli-operations.ts` 复核落盘先于发送、丢失确认、重启恢复、实例隔离及不确定结果，均通过。网页唤醒测试按实际新增的 Agent 版本标签修正键盘次序，保留方向键导航断言。

原生 TUI 旧脚本因 Docker socket 不可用失败；现复用本机 Wrangler，并让生产原生 CLI 创建可靠传输 bridge。测试 launcher 只导出隔离鉴权 loopback 地址供被观察的真实 TUI 连接，保留 initialize/thread/start 成功响应断言。Codex 新增的 command/exec、thread/turns/list 当前被拒绝；此次证明初始化成功，不证明全部可选 RPC 或模型任务兼容。

日志清单 `.local/final-history-regression/`：core/browser/maintenance/sanitize 组及 native 已通过项；唤醒与 TUI 的最终复测分别见 wake-final.log、native-tui-final.log，另有 cli-operations-final.log、retention-final.log、typecheck-final.log、lint-final.log、lint-cpp-final.log。早期失败记录保留，不能仅依据 native.json 的旧失败记录判断最终结果。整页 UI 日志仍为 `/tmp/coc-history-ui-test.log`。

线上仅按 ONLINE_BROWSER_TESTING 完成 Access/管理员认证及只读基线，生产仍是旧版本；新页面缺口显示及重载在本机真实 Chromium、合成接收端验证，真实 Agent 恢复另有专项证据。未修改正式用户库、启用生产退休或调用模型。长期压力、无样本类型、不可查未知请求退休与物理缩库按 HISTORY_STORAGE_OPTIMIZATION §12.4 延期。下一门禁为对应提交六项必需 GitHub Actions，之后才使用其制品发布及进行线上新版本验收。

## 历史优化阶段记录 · 2026-11-02（按时间保留）

索引退休前置条件：Agent 构建通过，历史预算专项最终 16.14 秒、来源专项 4.35 秒通过。新增归档负序分配器的旧布局迁移、两种归档入口、隔离夹具删除全部投影、写入故障回滚、空历史重启和安全整数下界拒绝；已提交身份不重用。新增 64 条记录配额下的持续恢复/淘汰，直到元数据准入背压，再重启核对所有已接纳引用与摘要；拒绝不改变旧历史或触发可重读导入的全局故障回调。日志 `/tmp/coc-archive-floor-{build,test,final-build,final-test}.log`。用户已确认允许已解除交付责任的旧引用明确过期并实现新快照/缺口协议，后续范围见优化方案第 12 节；当前没有自动投影删除、过期响应或新客户端恢复协议，未运行全量回归。

恢复凭据候选过滤：Agent 构建、来源专项最终 4.07 秒、历史预算专项 15.14 秒通过。共享正文描述符规则保证无 chunks 且不能缩小的短正文/未分类元数据不启动来源准备；有收益的文本与文件开始态、128 行边界、活动预留、运行中跳过和绕回继续验证。真实 Agent `--file-started` 自动准备/淘汰、Unicode 分页、并发拒绝、来源替换及 SIGKILL 重启回源通过。日志 `/tmp/coc-proof-filter-{build,test,clean-build,clean-test,agent}.log`；初次来源夹具错误地将一个实际可缩小的正文判为不可缩小，已修正，最终来源专项通过。未执行全量回归或删除既有恢复凭据，历史索引长期退休仍待完成。

网页未知队列恢复：Agent 构建、操作专项最终 21.10 秒、原生核心专项 33.37 秒通过，类型和定向 ESLint 通过。原生测试覆盖 ACK/重启保留原 wire body、字段顺序/空白、错误输入拒绝、旧代际关闭不恢复执行权、原结果/摘要保持、ACK 后清理、关闭流退休，以及清理失败时事实/退款/正文全回滚。最新真实 Agent 交付专项验证两类未知请求同时强杀重启、网页 ACK 保留证据、后台轮换查证、两条独立事实、已确认正文清理和源提交次数不变。日志 `/tmp/coc-web-queue-{final-build,fault-build,fault-test,final-delivery,typecheck,lint}.log`。使用确定性源，无模型调用或全量回归；旧版本已经清空的正文与已消费不可查的队列仍不能据此确定结果。

未知控制 RPC 队列后台查证：Agent 构建通过；操作专项最终 20.92 秒、公共预留保存点变更后的历史预算专项 15.82 秒通过；队列查询专项、类型和定向 ESLint 通过。新增重启/ACK 后身份恢复、128 行边界、输入/关联/项目拒绝、写入故障回滚、单次事实及原结果不变测试。真实 Agent 交付专项通过强杀重启后保留未知、源项重新可查后的后台退款、唯一原请求历史事实和 queue/add 次数不变。日志 `/tmp/coc-queue-retire-{build,test}.log`、`/tmp/coc-queue-reconcile-{agent-build,final-build,final-test,delivery,source,typecheck,lint}.log`。集成场景使用确定性源，不证明已消费不可见队列可恢复；网页命令未知承诺尚未接入，未运行全量回归或部署。

正文淘汰后强杀恢复：`tests/native-history-recovery.ts --file-started` 与 `--inline` 均通过。真实 Agent 自动淘汰后 SIGKILL，旧连接关闭、新 PID 启动，原引用首尾页及 history value/revision/recovery 不变，chunks 保持 0；来源替换拒绝及恢复原文件后的读取通过。TypeScript 类型与定向 ESLint 通过。日志 `/tmp/coc-history-restart-{agent,inline,typecheck,lint}.log`。该专项使用确定性源 peer，不等于真实 Codex 重启或最终浏览器验收；未运行全量回归。

网页引用段组装：`npx vitest run tests/web-events.test.ts` 14 项通过，TypeScript 类型与定向 ESLint 通过。新增 5 项验证迟到工具输出不隐藏在引用中、文本/工具片段不跨引用错序、旧工具拼接位置失效及无 itemId 片段边界。日志 `/tmp/coc-reference-assembly-{test,typecheck,lint}.log`。该批仅验证事件组装，未替代最终真实浏览器、Agent 重启或全量回归。

文件开始态后台接入：Agent/测试构建通过，来源专项 4.06 秒通过，类型检查和定向 ESLint 通过；真实 Agent 的 `npx tsx tests/native-history-recovery.ts --file-started` 自动准备、淘汰及原引用回源通过，覆盖 Unicode 多页、并发预算、来源替换拒绝。日志 `/tmp/coc-file-auto-{build,source,agent,typecheck,lint}.log`。另外真实 Codex 类型专项核验 4316 条候选，3407 条可恢复（1421 条实际回收、1986 条验证保留），909 条保留；净计费减少 4190908 字节，Store 重开复核与完整性通过。[完整类型矩阵](assets/history-storage-2026-11-02/source-type-coverage.json)。类型审计绕过后台候选调度，不能证明所有记录均会自动回收；缺少真实 MCP/plan/dynamicToolCall 样本，未运行最终浏览器/全量回归或修改正式数据库。

文件开始态恢复：Agent/来源测试构建通过，`native-history-source` 4.09 秒通过，新增未完成源及 diff 变化拒绝。真实本机 Codex 只读核验 106 条文件变更，原先 40 条开始态仅状态不同；按原事件重建状态后，106 条均能登记、淘汰并按原引用/摘要恢复，Store 重开复核通过，两份隔离库完整性均通过。[脱敏前后证据](assets/history-storage-2026-11-02/file-change-recovery.json)。构建/专项日志 `/tmp/coc-file-start-{build,test,audit-build}.log`；私有审计工具及输入在 `.local/history-implementation/{structured-cache-audit,file-start-audit}/`。没有模型调用、正式库替换或全量回归；重开 Store 使用已读取源证据，不证明源进程重启后的恢复，亦不覆盖真实 MCP。

结构化正文缓存：Agent/来源专项构建通过，最终 `native-history-source` 3.99 秒通过，类型检查及定向 ESLint 通过。新增普通和外部 fileChange/MCP 四类案例，验证原正文 JSON、引用、非正文元数据、退款、回滚、重启和源变化拒绝。真实本机 Agent 配合确定性 peer 的 `npx tsx tests/native-history-recovery.ts --file` 通过自动准备/淘汰、原引用 Unicode 多页读取、并发预算及来源替换拒绝。日志 `/tmp/coc-structured-cache-{build,final-build,final-source-test,agent-test,typecheck,lint}.log`。未使用真实 Codex 结构化历史作为该批集成来源，未执行全量回归或正式库迁移；真实来源及浏览器验收仍待完成。

已分类内联正文缓存淘汰：Agent 构建通过；最终来源专项 3.67 秒、历史预算专项 15.85 秒、引用专项 0.14 秒通过，TypeScript 类型及定向 ESLint 通过。C++ 覆盖流式文本、外部文本和工具 aggregatedOutput 的净缩小、原引用/修订稳定、精确退款、工具命令/退出码等非正文元数据保留、凭据恢复失败整批回滚、活动预留跳过、重复转换和重启；迟到 delta 不覆盖原前缀。超限库先跳过转换，日志回收后可继续，未触发全局停写。真实本机 Agent 配合确定性来源 peer，分别通过分块及 `--inline` 自动准备/淘汰、原引用回源、Unicode 多页、并发拒绝和来源替换拒绝；最终内联路径在元数据保留修正后重跑通过。日志 `/tmp/coc-inline-cache-{envelope-build,envelope-test,budget-test,final-agent-test,chunk-test,typecheck,lint}.log`。未执行全量回归、正式库迁移或最终浏览器验收；未知结构化正文和历史索引退休仍未完成。

外部队列确定性关联与终态前核对：Agent 构建、`build/coc-tests --external-queue`、TypeScript 类型及定向 ESLint 通过。C++ 子进程专项覆盖多页唯一匹配、缺失、输入改写、跨页重复关联、20 页边界、循环游标、超大页面；真实 Agent 交付专项验证丢回复后只读恢复原已入队回执及预留转换，原请求重试不重新派发，已消费不可见项继续未知并跨 SIGKILL 重启保留。夹具分别统计 queue/add 调用次数和唯一队列项，防止源端去重掩盖重复派发。真实本机 Codex 0.166.0 的 `python3 tests/external-codex.py` 通过 paginated/legacy 两种模式：确定性关联与完整输入回显，重建独立 reader 后原项仍可查；隔离 CODEX_HOME 使用关闭的本机模型端口，没有真实模型服务调用。日志 `/tmp/coc-queue-proof-{core-build,core-test,final-delivery-test,real-codex,typecheck,lint}.log`。未运行全量回归、修改正式数据或宣称跨重启未知终态核对已经完成。

运行实例终态崩溃恢复：Agent 构建通过，历史预算专项 15.19 秒、可靠操作专项 20.01 秒及定向 ESLint 通过。底层在全额账本注入终态投影失败，验证原普通/队列承诺及保护容量回滚；再次启动覆盖已为 failed 的状态，恰好补写一次 sessionClosed，后续重启不变，原创建仍返回 RESULT_UNKNOWN；辅助连接不执行恢复。真实 Agent 交付专项将最后一次重启改为 SIGKILL，验证旧外部运行实例保护槽转换、一个持久终态、未知队列容量和原请求结果保留，已有不完整输出历史不变。日志 `/tmp/coc-terminal-recovery-{build,test,delivery-test,lint}.log`。未运行全量回归、模型任务或修改正式库；未知业务承诺核对仍未完成。

外部观察及归档满额隔离：最终 Agent/预算测试构建通过，历史预算专项 15.17 秒通过，TypeScript 类型及定向 ESLint 通过。底层验证配额拒绝完整回滚、指纹/游标/标题不推进、空间恢复后同 seq 全文重读、真实存储错误仍触发故障回调以及作用域退出后普通写入故障行为恢复。真实 Agent 配合确定性 Codex peer 的交付专项通过：满额期间观察器标记待同步并保持服务；释放隔离测试预留后，沿原游标补齐原 item 增长和新尾部，队列/来源夹具不变；同一归档页连续两次明确返回容量拒绝，恢复容量后重读成功，未留下加载标记或关闭运行连接。日志 `/tmp/coc-observer-final-{build,budget-test,delivery-test,typecheck,lint}.log`。未运行全量回归、真实模型任务、最终浏览器验收或修改正式数据。

物理空间专项：只读原备份及优化隔离副本，另建 VACUUM INTO 测量文件。去重后的主库仍为 64.33 MiB，其中 45.09 MiB 空闲页可复用；离线压缩副本为 18.81 MiB，减少 45.52 MiB。44 张表全部行与 schema 一致，完整性检查通过，原副本行未变。三个离线库 WAL 均为 0，不代表线上 WAL/临时峰值；未替换正式数据库或启用自动压缩。[脱敏分表证据](assets/history-storage-2026-11-02/physical-storage.json)。

持续输出窗口与保护终态：Agent 构建通过；历史预算专项 16.17 秒、可靠操作专项 20.12 秒通过；共享配置 24 项通过，TypeScript 类型和定向 ESLint 通过。真实 Agent 交付专项通过：单会话计费填满后，已接纳的 8 条 delta 全部落盘，后续超额输出触发仅对应 Codex 进程停止，保护容量转换为不完整终态，原普通未知预留保留，其它会话及 Agent 继续服务；真实进程重启后历史和不完整状态一致。测试项目使用互不重叠的兄弟目录，避免前置配置拒绝。日志 `/tmp/coc-output-window-{final-build,test,delivery-test,policy-test,typecheck,lint}.log`。外部观察者持续同步的满额隔离尚未覆盖，未运行全量回归、模型任务或修改正式状态。

外部队列独立预留：Agent 构建通过，最终历史预算专项 15.58 秒、来源专项 3.36 秒通过，TypeScript 类型检查及定向 ESLint 通过。底层覆盖两笔并发承诺互不消费、普通任务预留不被回执借用、失败事务回滚、重启保留及按项退款。真实 Agent 交付专项新增控制 RPC/网页队列成功、原请求重试、源端已入队但丢回复、同会话满额拒绝；真实进程重启后未知预留不变、原请求仍返回 RESULT_UNKNOWN，源队列只出现预期的三笔提交。测试修正了前置故障主动断连后的握手等待，避免向已关闭连接发送新用例。日志 `/tmp/coc-queue-{index-build,final-test,test,delivery-test,typecheck,lint}.log`。未运行全量回归、模型任务或修改正式数据。

发送前准入原子化：Agent 构建通过，历史预算专项 16.41 秒通过，真实原生交付专项通过。新增 start 用户投影失败与 steer 增长预留后失败，核验任务状态、标题、事件/投影、字节/记录预留完整回滚；成功准入跨 Store 重开一致，容量不足不留下部分任务。网页/CLI 任务、资源背压、精确取消、未知结果和历史尾部恢复仍通过。日志 `/tmp/coc-atomic-admission-{build,test,delivery-test}.log`。未运行全量回归、模型任务或修改正式库。

迟到终态校验：Agent 构建及真实原生交付专项通过，定向 ESLint 通过。确定性 peer 在当前 turn 运行中注入另一 turn 的完成通知，并用后续通知确认处理顺序；验证当前 running/turnId/activeTask 与历史预留保持，实时流及历史页不含错误终态，之后精确中断正常释放预留。日志 `/tmp/coc-terminal-identity-{build,test,lint}.log`。未执行全量回归、模型调用或正式库修改。

原始事件分批回收：Agent 构建通过；历史预算专项 15.85 秒、来源专项 3.37 秒、引用专项 0.14 秒通过。覆盖 128 条批次上限、投影见证、孤立记录/活动会话/预留跳过、整批回滚、精确退款、重启和未知请求保留。真实原生交付及 Agent 自动日志/分块回收后的正文回源专项通过，定向 ESLint 通过。旧库隔离副本回收 48224 条事件，计费 175.76 → 35.26 MiB，355 个引用及其余 41 张表摘要不变；[脱敏证据](assets/history-storage-2026-11-02/journal-reclamation.json)。日志 `/tmp/coc-journal-{final-build,test,delivery-test,recovery-test,lint}.log`。未运行全量回归、模型任务、正式库迁移或部署；物理 DB/WAL 回收效果另待最终测量。

历史高水位解耦：Agent 构建通过，历史预算专项 14.60 秒通过，真实原生交付专项通过（确定性 Codex peer，无模型调用）。新增测试在隔离数据库清空 events 后检查历史快照、原引用、订阅高水位、确认与重启恢复，验证负序归档不覆盖历史、正序继续递增，以及投影写入失败不发布新高水位。只读旧库中全部会话的 MAX(events.seq) 与 MAX(history.revision) 一致；[审计结果](assets/history-storage-2026-11-02/event-journal-audit.json)。日志 `/tmp/coc-projected-head-{build,test,delivery-test}.log`。尚未启用自动事件删除；未运行全量回归或修改正式库。

旧库内联去重：Agent 构建通过；历史预算专项 15.06 秒、来源专项 3.38 秒、引用专项 0.14 秒通过。覆盖 Unicode、通用工具 JSON、运行/预留跳过、部分匹配片段可删除、冲突片段保留、后续删除失败的整批回滚、重启幂等与计量退款。日志 `/tmp/coc-inline-migration-{build,test}.log`。旧库隔离副本结合合并及去重后计费 275.20 → 175.76 MiB，355 个引用与 history/events/bodies 摘要不变，完整性检查通过；[脱敏证据](assets/history-storage-2026-11-02/inline-deduplication.json)。不是物理文件缩小证明；未运行全量回归、模型调用、正式库迁移或部署。

外部内联投影去重：Agent 构建通过，历史预算专项 14.31 秒、来源/投影专项 3.39 秒、引用专项 0.15 秒通过；仅运行 core 的 `--external-refresh` 专项并通过。覆盖无重复 chunks、相同 fingerprint 不新增占用、5000→20000 字节增长的增量事件与完整分块、转换故障回滚、缩小回内联、通用工具 JSON 正文语义。活跃外部会话超过 16 条后续新消息后仍能追踪旧条目终态。日志 `/tmp/coc-external-inline-{build,test,refresh-test}.log`。未运行全量 core/回归、模型任务、正式库迁移或部署。

新流式内联投影去重：Agent 构建通过；历史预算/转换专项 15.08 秒、引用专项 0.14 秒通过，最终来源专项 3.37 秒通过，真实原生交付专项通过。新增检查内联阶段无 chunks、11998 字节 Unicode 前缀跨阈值、分块写入故障的正文/修订/计量回滚、重启和字符偏移。保留旧重复 chunk 布局夹具；分别验证完整内联前缀沿用原流、已淘汰大前缀新建片段并保留旧引用。原生请求恢复、取消、信用与历史尾部恢复继续通过。日志 `/tmp/coc-inline-storage-{build,test,final-build,final-test,delivery-test}.log`。外部快照与旧库去重仍未完成；未运行全量回归或修改正式库。

内联副本读取修正：来源专项 3.32 秒、引用专项 0.14 秒通过；分块淘汰后删除 Codex 来源文件，完整本地内联正文仍按原摘要和 Unicode 偏移读取，伪造摘要引用拒绝。真实 Agent 集成测试改用 20 KB / 6000 Unicode 字符、无完整内联副本的正文，自动准备、自动回收和多页实际回源通过，来源替换及并发背压检查继续通过。日志 `/tmp/coc-inline-read-{build,test,agent-test}.log`。未做全量回归、模型调用、正式库修改或部署。

已验证分块缓存批次：Agent 构建通过；历史预算专项 14.62 秒、引用专项 0.14 秒通过，最终来源/回收专项 3.31 秒通过；20 项共享配置用例、TypeScript 类型检查和定向 ESLint 通过。覆盖新鲜源验证要求、删除故障事务回滚、活动预留与未验证正文固定、计量退款、原引用稳定、有序分块回收及淘汰后的迟到 delta。真实 Agent 使用 `cacheMaxBytes: 0` 自动准备凭据并自动删除测试 chunks（不再由测试脚本删除），history/events 保留，原引用回源、Unicode 页、来源替换与并发背压继续通过。日志 `/tmp/coc-history-cache-verified-test.log`、`/tmp/coc-history-cache-final2-{build,test,agent-test}.log`、`/tmp/coc-history-cache-{policy-test,typecheck}.log`。未覆盖全量旧库空间效果；内联正文及事件日志仍保留，真实 Codex/线上浏览器最终验收和全量回归尚未执行。

自动准备恢复凭据批次：Agent 构建通过，最终来源专项 3.22 秒通过；覆盖 128 行扫描边界、跨批次与绕回、运行中及活动预留跳过、原候选修订变化拒绝。真实 Agent 测试改为未登记状态启动，等待现有 30 秒维护周期自动准备，再删除隔离测试 chunks，原引用回源、Unicode 页、来源替换与并发背压检查通过；没有人工注入恢复元数据。定向 ESLint 与 TypeScript 类型检查通过。日志 `/tmp/coc-history-prepare-final-{build,test,agent-test}.log`、`/tmp/coc-history-prepare-typecheck.log`。仅使用确定性只读 Codex peer，无模型调用或正式库修改；缓存自动淘汰、真实 Codex/线上浏览器最终验收及全量回归尚未完成。

Agent 正文回源批次：Agent 构建通过，历史预算专项 13.72 秒、来源恢复专项 2.80 秒通过，TypeScript 配置共享用例 17 项通过。新增真实 Agent 隔离测试 `tests/native-history-recovery.ts` 通过：先用 C++ Store 登记精确恢复凭据，再移除测试库 chunks，经 Agent 内容接口返回原正文；核对 Unicode 页、错误摘要、来源文件替换拒绝、并发 BACKPRESSURE 与错误后名额释放。夹具只处理只读 RPC，不调用模型。日志 `/tmp/coc-recovery-{route-build,route-test,agent-test,policy-test}.log`。自动凭据准备、缓存回收及真实 Codex/线上浏览器最终验收仍未完成；未运行全量回归或部署。

原生标识与内联恢复批次：Agent 构建通过，历史预算专项 13.71 秒、最终来源恢复专项 2.76 秒通过，原生交付专项通过。新库不存在独立来源映射表；同会话第二条恢复凭据不增加计量记录，新增计费不超过 256 字节，且不复制原生标识或事件模板。覆盖来源写入后凭据写入故障的整笔回滚、重启、重复登记、会话来源变更与退款、history 修订/替换/删除失效。原生请求恢复、精确取消、预留、输出信用和历史尾部恢复继续通过。日志 `/tmp/coc-inline-{build,test,source-test,delivery-test}.log`。旧 3367 条映射样本成本仅作为历史基线，尚未重新统计全样本新布局；未修改正式数据、启用淘汰或运行全量回归。

来源身份适配批次：Agent 构建通过，新增公开 thread 元数据与文件身份校验；最终 `native-history-source` 专项 2.74 秒通过。覆盖读取期间追加、归档移动、替换、预期来源冲突（条目读取前拒绝）及缺失 path，另验证文件缺失、目录、FIFO、越界符号链接。未直接读取 Codex 数据库，未接入 Agent 缓存淘汰；Windows 分支未运行。只运行必要专项，未运行全量回归、线上测试或部署。

持久来源关系批次：Agent 构建通过，历史预算专项 14.47 秒通过；最终来源/投影/持久化专项 2.13 秒通过，新增事务中途故障回滚、幂等与重启、来源重绑/跨会话拒绝、预留和额度隔离、模板正文去重、线性片段查找及 history UPDATE/REPLACE/DELETE 的计量退款。本机隔离副本注册 3367 条关系，逐条恢复并在重新打开 Store 后核对全部原引用；元数据额外计费约 10.80 MiB，正文未删除。[脱敏证据](assets/history-storage-2026-11-02/source-mapping.json) 明确测试来源标记不代表生产身份适配已完成。日志 `/tmp/coc-history-map-test.log`、`/tmp/coc-history-map-linear-test.log`，私有证据 `.local/history-implementation/source-map-{audit,reopen}-result.json`。未运行全量回归、模型任务或部署。

投影与恢复差异批次：Agent 构建通过，历史预算专项 13.70 秒、来源/投影专项 1.89 秒通过；新增原字段形态、不可见元数据变化、旧正文前缀、UTF-8 字节片段、越界/错位、改写及 revision 冲突检查。本机旧库副本 4316 条候选通过真实 Codex API 逐条比较，3337 条规范化后正文精确匹配，2 条前缀及 28 条已登记片段通过恢复接口的原摘要验证；除开始态外 2769/2774 条可精确恢复，4 条源输出截短、1 条终态来源缺失继续保留必要快照。另 443 条项目不在当前配置，未跨项目探查。[脱敏证据](assets/history-storage-2026-11-02/recovery-comparison.json)。未删除正式正文，未启用缓存淘汰；没有全量回归或模型调用。日志 `/tmp/coc-history-recovery-final-test.log`、`/tmp/coc-history-recovery-revision-test.log`，私有比较结果 `.local/history-implementation/recovery-audit-final.json`。

只读来源基础批次：Agent/专项目标构建通过，新增 `native-history-source` 的 18 个场景通过（1.81 秒），覆盖双重来源校验、身份/模式变化、缺失/重复条目及大小限制。本机 Codex 0.166.0 的 10 类已完成样本通过 C++ 入口在两个独立进程重读，完整条目摘要一致，无模型调用；[脱敏证据](assets/history-storage-2026-11-02/source-read.json)。这尚不证明旧修订、全部条目变体或淘汰安全。日志 `/tmp/coc-history-source-{build,test-final}.log`，私有样本证据在 `.local/history-implementation/source-probe-result.json`。 重建 `coc-tests` 后仅执行 `--external-refresh`，原有活跃外部会话超过 16 个新条目后仍能追踪旧条目终态的专项通过，日志 `/tmp/coc-history-source-refresh-test.log`。

旧分块迁移批次：Agent 与历史测试目标构建通过，历史预算/引用专项通过；新增活动预留跳过、固定批次上限、删除后故障回滚、跨重启引用/快照不变、超限库净减及容量触发器恢复验证。本机旧库的隔离在线备份经过 314 批合并，chunk 从 40163 条降到 363 条，计费 275.20 → 176.85 MiB，355 份正文 SHA-256 及历史相关表摘要不变，完整性检查正常。详见 [脱敏结果](assets/history-storage-2026-11-02/packing.json)；正式库未修改，不能据此声称磁盘文件缩小或最终线上验收通过。 最终历史预算专项 13.88 秒通过，额外注入异常计量增长验证提交前拒绝及回滚；真实 Agent 交付专项通过，覆盖原请求恢复、精确取消、输出信用与历史尾部恢复。日志 `/tmp/coc-pack-migration-{build,test,delivery}.log` 和 `/tmp/coc-pack-migration-test-final.log`。

小 delta 尾块合并批次：重新构建历史预算与引用测试目标后，两项 CTest 通过（13.99 秒 / 0.12 秒）。3000 条 Unicode delta 形成 6 个 chunk，验证跨块/跨页随机字符偏移、重启后完整正文和投影失败的正文/计量事务回滚。日志 `/tmp/coc-packed-{build,test}.log`。未运行全量回归；没有对正式历史库执行迁移或删除。

任务初始预留批次：Agent 构建通过，`npx tsx tests/native-delivery.ts` 通过，新增运行中持久字节/记录预留及精确取消完成后释放余额断言；原有命令恢复、输出信用、慢接收方与历史尾部恢复检查继续通过。日志 `/tmp/coc-turn-reservation-test.log`。使用确定性 Codex peer，未调用模型；未运行全量回归或部署。

配额与早期准入基础：C++ 历史预算专项通过，包含新旧库额度更新、调低保留数据、辅助连接不覆盖额度、策略迁移故障回滚和拒绝写入原子性。相关 TypeScript 配置/协议/远程配置 3 文件 25 项通过，类型检查通过。真实 Agent 原请求生命周期专项通过，新增低配额创建前拒绝、保持可查询、重启调高后原请求不重执行；原有重复派发、丢回执、实例隔离、未知结果与确认覆盖保留。

使用本机实际配置执行开发版 `doctor --proxy ''` 的只读检查：数据库完整性正常，历史 288563401 字节/97209 条，明确报告全局和单会话两项超限；未迁移本机正式数据库或修改其配置。私有证据在 `.local/history-implementation/doctor.json`，专项日志在 `/tmp/coc-history-policy-*.log`。

这仅是第一批基础验证，不代表历史优化方案全部实现。持久预留、回源与有界缓存继续实施；按用户要求，所有改动完成后才执行全量回归及最终本机/线上浏览器验收。

## 发布门禁复验（已通过）

用户已授权在 GitHub Actions 全部通过后发布。首次 [Actions 41308571146](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41308571146) 验证 `5ed84e6`，最终失败：Ubuntu 20.04 编译、sanitizer 两项超时、TLS/Access 夹具和 Windows 临时目录清理。不能使用其部分成功制品发布。

已本地复现 Ubuntu 20.04 的 JSON 隐式插入歧义，改为显式字符串转换后，隔离 Ubuntu 20.04 完整原生构建通过；Access 夹具补齐 delivery:2 握手后通过。sanitizer 原请求测试在原 60 秒上限超时；保留全部容量样本后，两项测试在独立 240 秒上限内分别约 54 秒、84 秒通过，其余六项首次本机 sanitizer 已通过。Windows 日志确认文件夹具仍持有数据库/上传句柄，现将析构提前到临时目录清理前，实际 Windows 结果须待下一次 CI。

第二次 [Actions 41310461976](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41310461976) 验证 `abd9ef3`：Ubuntu 20.04、Debian 12、musl、Windows x64 和 sanitizers 全部成功；常规回归的完整 E2E 与 UI 已通过，但缓存夹具手工拼接源码漏掉共享重试依赖，导致 Cache 未定义。该运行仍不能发布。

按用户要求，后续修复先完整本地验证，再推送。缓存夹具改为打包真实模块依赖；游客 WebSocket 夹具补齐 delivery:2 查询参数；更新夹具显式设置安装副本为 0755，避免开发目录 umask 0002 导致更新器正确拒绝组可写程序。未改变生产版本拒绝、权限、缓存预算或更新器文件权限检查。

27 组本地发布回归全部通过：lint、C++ 格式、类型、协议生成、完整构建、8 项 CTest/414 项 Vitest、TLS/Access、计费、项目、传输、配置、登录、备份、发行来源、Agent/云端发布脚本、Access 工具、CI 摘要、更新器、普通 E2E、UI、缓存、网页计费、网页 Access/游客、项目 E2E、D1 迁移和 D1 E2E。两种后端 E2E 各 42 项通过。结果记录在 `/tmp/coc-release-local2/results.json`，分项日志在同目录；曾失败的夹具修复后从对应检查点重新验证及继续，未缩短真实重连等待或跳过后续检查。

最终 [Actions 41314704820](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41314704820) 验证 `4b164c62fe93581903d5ead53d367c4675a74360`：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；分支 publish-release 正常跳过。仅该运行的制品用于 0.6.0 发布。线上健康、网页资源及五份新包摘要通过，认证边界与旧归档补验见发布证据。以下“本机，未部署”段落保留此前阶段的验证边界，不代表当前发行状态。

## 阅读范围

- [最新协议简化验收](#协议简化最终验收--2026-11-01本机未部署)：八批实现后的构建、回归与边界。
- [历史验收记录](history/TEST_REPORT_2026-11-01.md)：此前 0.6.0 改造、旧更新器、各批阶段验证及 0.5.x 记录，保留原提交和证据。
- [简化决策与测试索引](TRANSPORT_SIMPLIFICATION_DECISIONS.md)：每项删除/保留决定对应的实现与故障测试。

新增结果应先更新本页当前结论，并明确源码、环境、执行结果与未验证项；旧结果按日期归档，不将进行中的检查写为通过。真实发布证据只在 DEPLOYMENT_STATUS 中认定。

## 协议简化最终验收 · 2026-11-01（本机，未部署）

本轮八批实现提交依次为 `a70dbf1`、`754f051`、`9347d68`、`710c120`、`ef0f475`、`cf00c11`、`7f492d9`、`f1069db`。删除/保留决定和源码、测试对应关系见 [最终决策矩阵](TRANSPORT_SIMPLIFICATION_DECISIONS.md)，逐批崩溃一致性说明见 [审计记录](TRANSPORT_SIMPLIFICATION_AUDIT.md)。本节是本轮执行结果，不复用此前发行验收作为新证据。

| 验证                                                         | 实际结果与范围                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                              | 第七批全构建通过：原生、Web、TypeScript、Worker dry-run；不发布                                                              |
| `npm run build:native`、`npm test`                           | 第八批最终原生构建通过；8 项 CTest、27 文件/414 项 Vitest 全通过                                                             |
| `npm run test:delivery`                                      | 第八批真实 Agent 命令/结果恢复、精确取消、transfer 校验、稳定预留、输出信用、慢接收方、关闭流结果及历史尾部恢复通过          |
| `npm run test:e2e`                                           | 第八批最新二进制 42 项全通过；真实 Wrangler/Agent/CC/Chromium，确定性 Codex peer；含权限撤销、多主机多标签页、重连与上传故障 |
| `npm run test:operations:web`                                | 36 项单元测试和真实浏览器锁、持久顺序、页面关闭、丢 ACK、空闲停止及清缓存隔离通过                                            |
| `npm run test:uploads:web`                                   | 8 项单元测试及真实 IndexedDB 20 MiB 完整正文准入、重开、摘要、清缓存隔离和未决文件背压通过                                   |
| `npm run test:projects:e2e`                                  | 真实 Worker 配置读取/替换/重启与去重，Agent/CC/Chromium 项目 CRUD、管理员绑定和配对通过                                      |
| `npm run test:configuration`                                 | 第七批摘要实现变更后，Agent 重启、CC 原命令保持、重复重启、离线拒绝、替换备份及 TUI 清理通过                                 |
| `npm run lint`、`npm run lint:cpp`、`npm run protocol:check` | ESLint/格式、C++ 格式、生成协议一致性通过；最终文档另做格式和 diff 检查                                                      |

新增存储精简测试验证原布局转换、相同身份/控制证明、重启幂等、关闭游标重建，以及控制实例、命令摘要、关闭检查点三类冲突回滚全部表转换。创建关联测试验证 session 和原请求证据写入的事务失败回滚及重启可查；外部初始化未提交终态仍返回未知，不声称跨 Codex/文件系统事务 exactly-once。

确定收益是三列持久状态删除、关闭少一次 UPDATE、启动少一次正文回填扫描、恢复少一次后缀查询/构建、transfer 少一次摘要和乱序结果少一份正文；帧类型、网络往返及固定资源上限不变。没有重新测量生产 RSS、长期负载或费用，不沿用历史资源样本声称本轮性能增益。

本机日志为 `/tmp/coc-batch8-{build,test,delivery,lint}.log`、`/tmp/coc-complete-{e2e,operations-web,uploads-web,projects,lint,protocol}.log` 和 `/tmp/coc-final-{build,configuration}.log`。这些是本机临时证据，不是发行制品或远程 CI 证据。本轮未调用模型、未推送、未运行远程多平台 CI、未验证真实 Cloudflare 休眠/长期中断、未部署。持久布局转换仅使用隔离测试库；实际升级必须遵循 RELEASE 的备份及回退边界。

### 2026-11-02：历史退休前的持久高水位与收尾范围

新增每会话持久高水位，同原历史资源账本计费；分页、交付 heads 和订阅提示共用。旧库从投影迁移一次，投影删除不会重新分配或倒退检查点。隔离测试覆盖旧布局迁移、全投影/日志删除、重启、下一条修订推进，以及高水位更新失败时投影和预算一并回滚；已有订阅、外部历史更新和预算专项同时通过。

`native-history-budget` 最终 15.94 秒通过，构建与测试日志为 `/tmp/coc-history-head-{build,test}.log`。记录预留测试按新增高水位计入 9 条而非 8 条；模拟全部删除的测试明确区分仍需保留的高水位和可退款正文。未放宽生产配额。此批没有启用投影自动退休，不证明缺口协议或浏览器恢复已完成。

根据用户最新要求，长期压力优化、缺少真实样本的类型扩展、无法查证的已消费未知队列自动退休、自动物理缩库和额外抽象优化延期，触发条件详见 HISTORY_STORAGE_OPTIMIZATION §12.4。本批仅运行必要专项，未运行全量回归、推送或部署。

### 2026-11-02：显式引用释放检查点

现有历史 ACK/retire 可携带 releasedRevision，独立于投影 receivedRevision 持久保存；普通 ACK 和不带该字段的关闭不释放正文责任。原生订阅测试验证超过确认位置、非整数、null 拒绝，释放单调，普通后续 ACK 不扩大释放，以及重启后保留原释放位置与分配身份。沿用原事务和订阅数量上限，未增加逐引用映射。

`native-core` 最终 34.08 秒通过，协议 schema 专项 6 项通过，TypeScript、协议生成一致性及定向 ESLint 通过；日志 `/tmp/coc-history-release-{core-test,schema-test,typecheck,protocol,lint}.log`。CC/CW 尚未发送释放字段，尚未启用自动投影删除或证明过期/缺口恢复完成；仅运行相关专项，未运行全量回归、推送或部署。

### 2026-11-02：投影退休事务与版本化缺口快照

本批 Agent 构建通过，`native-history-budget` 16.77 秒通过；共享 JSON 配置/协议专项 33 项、类型检查、协议生成一致性和定向 ESLint 通过。日志 `/tmp/coc-history-retire-{build,test,schema-test,typecheck,protocol,lint}.log`。

隔离真实 SQLite 库验证：普通 ACK 不允许删除；另一个标签页未释放及未决历史预留阻止退休；释放后按配置保留两条最近投影；覆盖更新注入失败时投影、引用、依赖和预算全部回滚；成功退款；旧协议明确拒绝；版本 2 明确返回缺口和保留快照；过期引用拒绝；分页代际改变拒绝；重启后覆盖边界和过期语义一致。无候选重复调用不推进代际。

此证据覆盖 Store 事务与 Agent 编译，不覆盖完整线上恢复。未接通后台退休调度、HTTP 全部包装及 CC/CW 快照替换，默认保留配置为 0；因此未启用自动删除、未运行全量回归或部署。长期压力优化按计划延期，但基本客户端恢复和本机验收仍是启用门禁。

### 2026-11-02：客户端缺口快照与 IndexedDB 原子替换

`npm run test:cache` 真实无界面 Chromium 通过，新增缺口替换后重开、较新实时尾部/检查点不倒退、草稿/订阅/未决 outbox 保留、旧正文缓存删除、超预算整笔回滚和低代际拒绝。新增用例使用独立 origin，保留原共享身份多标签页 16 个总命令预留的断言；未扩大配额以通过测试。

Agent 与 CLI 构建、TypeScript 和定向 ESLint 通过；日志 `/tmp/coc-history-client-{browser-test,build,typecheck,lint}.log`。HTTP 包装与 CC 仅构建验证，本批浏览器测试直接使用真实缓存模块，不能代替线上页面或真实 CLI 端到端恢复证据。尚未接通自动释放、分页代际重试及后台调度；未运行全量回归、推送或部署。

### 2026-11-02：释放 ACK、分页代际重试和真实 Agent 定时退休

CC/CW 复用已有 ACK 与快慢重试，只有持久视图水位才可发送 releasedRevision；重连可补充此前未完成的释放，不重新执行业务。网页旧页遇到覆盖代际改变重新获取最新快照。JSON retainedRecords 非零时正常维护轮转一个会话并最多退休 128 条，默认关闭。

原生历史预算 16.16 秒、核心 33.37 秒通过；网页订阅/水位 18 项通过，类型及定向 ESLint 通过；Agent/CLI 与所需测试目标构建通过。真实 Agent 专项 `npx tsx tests/native-history-recovery.ts --retention` 通过已有源核验、分页和 SIGKILL 重启，并新增正常维护调度触发退休、旧引用明确过期、缺口快照、旧协议及旧代际拒绝。测试只在临时库增加合成投影，不重放任何业务请求；使用确定性 Codex peer，不等同真实 Codex 或线上整页验收。

日志 `/tmp/coc-history-enable-{final-build,native-test,agent-test,web-test,typecheck,lint}.log`。本批未运行全量回归、推送或部署。仍须完成真实来源/本机网页端到端收尾后进入全量测试；长期压力和遗留订阅治理按文档延期。

### 2026-11-02：真实来源、认证复核与整页缺口验收

新启动真实 Codex 0.166.0 只读进程，重新读取隔离备份中全部 1421 条已淘汰正文；1421 条均与原引用及摘要一致，没有复用上轮来源响应。原库不变，隔离库 integrity_check 为 ok；脱敏证据见 assets/history-storage-2026-11-02/fresh-reader-recovery.json。

按 ONLINE_BROWSER_TESTING 的认证专用 headless Context 验证 Access 邮箱有效；正常重建过期 CoC 管理员会话后只读管理员接口 200。线上仍为旧版本，此项不是新源码上线证明。凭证、截图与机器本地证据仅在忽略目录保存。

当前 Web 构建的 `npm run test:ui` 通过原整页专项及新增缺口场景：HTTP/WS 合成接收端返回版本 2 缺口，旧消息替换为唯一保留消息、过期提示可见，重载后仍只有新视图。测试暴露并修复普通返回最新消息也绕过缓存的问题；原“一次滚动刷新只读一次快照”断言保留并通过。新增测试曾漏协议能力头，被客户端正确拒绝，补齐测试头后通过，未放宽产品校验。

Web 构建、类型及定向 lint 通过，日志 `/tmp/coc-history-ui-{build,test,typecheck,lint}.log`。这是本机真实浏览器加载当前页面、合成接收端控制故障的证据；与真实 Agent 专项分别标注，不声称生产 Worker 已更新。实现阶段专项完成，下一阶段运行全量回归，失败项直接修复；未推送或部署。

### 2026-11-02：全量回归首轮与 reader 容量修复（回归仍在进行）

全构建通过。核心组最终 9 项 CTest、28 个文件/449 项 Vitest、全量 lint/C++ 格式、类型及协议一致性通过；sanitizers 9 项 CTest 全通过（271.50 秒）。登录、部署脚本、Cloudflare Access 工具、CI 命令包装、备份、发行 provenance、自动更新测试组全部通过。TLS/Access、计费与长时重试、项目专项已通过，其余原生与浏览器集成仍在运行，不能据此宣称全量完成。

首轮发现并修正三处旧断言：登录配置字段集合纳入 historyStorage 且验证默认不退休；初始化预算计入固定高水位；丢失队列回执经原请求只读找回后允许原结果为 queued，并明确检查 queue/add 只增加一次及原 queueId 相同。没有放宽总配额或重复执行保证。

真实 Worker/Agent 集成还发现后台准备 reader 在共享配额已满时逃逸 BACKPRESSURE、退出 Agent。现只跳过该轮可选准备；新 Agent 复测已越过原失败点，日志记录准备跳过而原会话继续工作，完整集成尚待最终结果。更新 npm test:delivery 纳入 --retention，使 CI 常规交付组覆盖定时退休、过期与缺口，不只靠手工专项。

运行清单及日志保存在 `.local/final-history-regression/`，失败首轮保留于 attempt-1/attempt-2，未覆盖或隐藏；旧 Agent 已退出的失败 e2e 仅终止其确认的隔离测试进程树后重跑。正式用户 Agent、配置与数据库未修改，未推送或部署。

### 2026-11-02：0.6.1 首轮 CI Windows 夹具修复

Actions 41417410092 的三套 Linux 与 sanitizers 通过；Windows 构建成功，但 native-history-source 首个用例因临时目录字符串未规范化，被来源校验拒绝。修正五处合成 origin 的 projectPath，统一使用已创建目录的 filesystem::canonical，与生产来源生成及原有持久来源夹具一致；不放宽生产路径、来源身份或权限检查。该失败运行不得用于发布，修复后以新提交的完整 CI 作为门禁。

### 2026-11-02：用户指定先发布上一轮云端

用户明确授权先发布 Actions 41417410092 的云端文件，再等待 41420076469 完整通过后发布配套版本。前者 regression 已完整通过，Windows 来源夹具失败；新增严格 cloud-only 例外，保留原生下载，要求其余五项全部成功，禁止发布新原生包及通知更新。增加来源/事件/完成状态/缺失或跳过检查拒绝和参数互斥测试；最终部署证据另记准确来源与例外，不能将该首轮描述为全绿。

### 2026-11-02：Windows 来源 peer 启动修复

第二轮 Windows 已越过规范路径夹具，随后来源读取用例因 codexPath=node 没有 .exe 扩展名而被原生启动校验拒绝。Windows 测试 peer 改用 node.exe；Linux 保持 node，生产禁止脚本启动器的校验不变。再次运行本机来源专项后推送，Windows 行为以新一轮准确提交 CI 为准。

### 2026-11-02：Actions Windows 依赖缓存刷新

首轮 Windows 日志显示两个 Actions 缓存均命中，但 vcpkg `Restored 0 package(s)`；配置阶段 09:02:34–09:10:30 UTC，约 8 分钟。旧精确键在工具链变化后无法写入新包。工作流增加镜像/工具版本及运行唯一键，配置后立即保存完整或已完成的依赖包，后续失败仍保留；恢复后的 ABI 校验、完整测试及制品来源校验不变。此优化与当前发布源码隔离，不能宣称已加速正在运行的 CI；效果须由后续运行确认。

### 2026-11-02：Windows 绝对 peer 路径和测试时间预算

Actions 41423136328 的 Windows 来源测试从扩展名校验推进到 CreateProcessW，但显式 applicationName 不搜索 PATH，node.exe 短名仍无法启动；现由 CMake 查找并传入绝对路径，工作流固定测试 Node 版本。该轮 native-operations 60 秒超时，前两轮分别 56.68、53.05 秒通过；Windows 项目/操作测试使用与 sanitizers 相同的 240 秒上限，不改变业务重试、存储持久性或断言。完整发行仍等待新准确提交通过，首阶段云端及已授权本机测试继续运行。

部署等待的公共 API 在多轮运行后触及匿名限流；改用已有 gh 认证读取元数据。新增已登录、未登录/未安装、认证请求失败不得退回公共接口的测试；云端和 Agent 部署边界测试一起复测。制品下载凭据与 Cloudflare 入口凭据仍隔离，不向公共下载代理传递 GitHub 令牌。

### 2026-11-02：CW 线上浏览器只读验证

本地源码基线 `bb801bfb6dff417b899846e8a57391903f80807d`；线上页面显示 0.6.1，此次没有部署，也未核验线上资源与该提交完全一致。

使用 Playwright Chromium 和已有邮箱登录状态，在配置的线上站点验证邮箱身份、管理员接口、CW 邮箱授权主机列表，以及一台真实在线 Agent 的项目列表、会话目录和已结束会话正文。刷新页面后等待原会话中的已知正文重新可见，验证主机 / 项目 / 会话选择及正文恢复。390 × 844 视口下 document.body.scrollWidth 与 innerWidth 均为 390。完成的最终浏览器记录未出现 pageerror 或同源 HTTP 4xx/5xx。单次已记录 API 请求约 0.25–6 秒；此数据不是性能基准。本轮未发现可复现的产品缺陷。

本地 `npm run build:web`、`npm run typecheck`、`npm run test:ui`、`npm run test:operations:web`（36 项单测及浏览器场景）、`npm run test:uploads:web`（8 项单测及浏览器场景）通过。构建仍有已有的 JavaScript chunk 大小提示。操作 / 上传专项覆盖丢失 ACK、页面关闭恢复、持久顺序、清理隔离及 20 MiB 上传；这些是本地测试，不能视为线上写操作验收。

本次线上不创建模型任务、不提交审批、不上传或改写远程文件、不恢复或中断既有任务，未验证真实模型输出、线上上传下载、审批、断网重连和多浏览器并发。首次探测脚本使用固定等待和不稳定的历史标题定位而超时，改为等待界面就绪及验证已知正文后完成；该探测问题不计为产品缺陷。含私有历史、登录态及截图的记录仅保存在忽略目录 `.local/online-tests/`，不提交。

### 2026-11-02：CW 真实模型、审批和卡顿修复

本轮独立记录见 [CW 完整功能测试与修复记录](CW_FUNCTIONAL_TEST_2026-11-02.md)。真实在线会话完成多轮上下文、/model 切换、Python 文件生成 / 断言、提权允许 / 拒绝、自动批准、停止和文件往返；发现历史数据确认先于引用释放时生成新 ACK 的风暴，已修改 CW / CC 保留原请求与退避。修复后 450 项 Vitest、9 项 CTest、网页构建、类型检查、界面回归通过；浏览器加载本地修复资源连接线上服务的联调确认控制消息显著减少。修复尚未部署，不宣称线上已恢复。

### 2026-11-02：部署后重测、并行压力及结束状态修复

用户授权本地构建部署，22b4f91 已发布且线上资源完整复核；未升级本机 Agent。核心功能重测通过，3 并行只通过 1 个，压力测试未通过并继续定位。浏览器旧页缓存复访 61 毫秒、0 额外分页请求。新增刷新 20 秒界限、取消错误区分及结束状态最多 60 秒确认。详情和证据见 CW_FUNCTIONAL_TEST_2026-11-02.md；本地 453 项 Vitest、类型检查、网页构建通过。

补充定位：可靠命令结果明确返回 PROJECT_BUSY，原同项目 3 并发脚本错误等待所有任务同时执行。保留项目互斥，调整验收为及时拒绝、草稿保留以及用户显式后续发送。修复版本 cb11b05 已本地构建部署并完整核对线上资源，完整 UI 回归及 lint 通过；3 会话策略验收通过，真实结束状态确认无 AbortError 弹窗。

后续规则实现：同项目控制连接一写多读，PROJECT_READ_ONLY 发生在连接准备阶段，保留历史通道；当前快照不等待目录/身份与命令回执恢复。456 项 Vitest、类型检查、lint、完整 UI 回归通过，包括五个同时 claim 只有一个成功、读会话显式申请、命令读取挂起不阻塞快照，以及 20 秒总截止时间。

最终线上 4dd46a5 部署资源完整核对，Agent 原 PID 保持 active。按新规则 3 会话 1 写 2 读、5 会话 1 写 4 读通过角色、真实 Python 工具任务及显式权限移交；任务阶段分别 25.143 / 32.687 秒，3 会话读端刷新 5.843 / 6.854 秒，无刷新超时。并发创建/建连阶段仍慢，详细限制与旧失败轮次保留在独立记录；不宣称性能全部通过。最终源码 456 项 Vitest、类型检查、lint、网页构建及 UI 回归通过。

最终清理及负向提示核对完成：3 / 5 会话共 8 个测试会话全部 UI 确认结束，并以 Agent 数据库只读逐 ID 核实 closed、running=false；无 pageerror / AbortError 弹窗。5 会话读端刷新 5.841–11.882 秒，无刷新超时。脱敏指标随独立测试文档提交。

### CW 浏览器压力纳入持续回归

普通 Worker / D1 的完整 E2E 均调用 3 / 5 独立浏览器压力 helper，检查一写多读、模拟命令审批、并行刷新、权限移交及最终结束，记录指标和失败截图。本地普通 Worker 完整 E2E 与 460 项 Vitest、类型检查、lint 已通过；增加完成快照先于 prompt ACK 的乱序回归，修复迟到确认恢复等待指示的问题。线上真实模型验收与模拟 peer 回归的证据和性能限制分别记录，详见独立测试文档。

最终 df4caea 的 Actions 41458682983 六项必需作业全部成功，两种后端共四个压力阶段、16 个会话全部确认结束。网页 / Worker 及 Ubuntu、Debian、Windows 包已使用该运行 CI 制品发布并核对线上字节与 SHA-256；musl 0.6.1 超限，按用户明确要求暂缓并保留旧包。部署 helper 新增暂缓路径及 14 项专项测试通过，证据、提交区分及 bzip2 23.77 MiB 格式评估见独立测试记录。

### 浏览器预留及 Agent 重连续修

固定预留改为完成账本按实际计费、仅未决交付保留余量，增加旧账本原子迁移及可重建缓存回收；修正 Relay 在旧 Agent socket 尚未关闭时选择旧 epoch，并改善网络失败提示与读取恢复。本地 466 项 Vitest、类型、lint、构建、完整 UI / E2E 及真实双标签页 IndexedDB 回归通过，覆盖 16 份旧预留迁移、66 份空闲账本、未决身份保护、完成释放、HTTP / 上传终态身份、缓存回收及失败回滚。本次续修的线上状态不能沿用上一提交的部署结论，详见独立 CW 测试文档。

部署工具已增加本机目标及显式本机编译例外，定向回归覆盖 CI 默认路径不变、指定 push remote 的仓库核验、拒绝脏/变动源码、本机复用安装 helper 及候选文件不覆盖。实际发布结果见部署记录。

本轮部署前检查：476 项 Vitest、本机 Agent 部署工具 16 项、云端部署工具 15 项、lint 与类型检查通过。生产配置增加原 D1 绑定及模式的回归保护；真实 Wrangler 的迁移与部署结果随后记入本次发布记录。

生产资源检查发现 HTML 规范路径重定向导致图表最终响应套用普通防嵌入 CSP，另发现构建器内联字体被默认策略拒绝。修正图表规范路径、对应专用 CSP 与 data 字体范围；34 项 Access/响应安全测试、实际 Chromium 高级 Markdown 测试、网页构建、类型与 lint 通过。线上补发结果见本次部署记录。

### CW 菜单及可拖动分隔条（2026-11-03）

整页 Chromium 回归通过：移除工具栏、四个入口收纳到功能菜单并自动关闭；文件树 / 文件预览 / 命令输出拖动后尺寸实际改变，文件树方向键调整并写入同一份偏好。窄屏边界修正后整页回归复测通过。完整普通 Worker E2E 通过，含从菜单打开 Linux bubblewrap Terminal、实际输入 / 输出、拖动高度后输出保留、390×480 短屏与显式终止；3 / 5 浏览器压力仍通过。477 项 Vitest、类型、lint 与网页构建通过；既有持久宽度上限测试同步调整为新的 640 px 上限。

按用户明确要求，本机配置仅将 terminal.enabled 改为 true（其他字段语义一致），空闲时重启，30 秒稳定连接验证及实际隔离 PTY 专项通过。配置原文和数据库备份保存在私有 .local；本次功能更新的云端部署证据见发布记录，不将本机构建描述为 CI 制品。

最终已使用本地源码 8e2ae8a 发布网页 / Relay，健康及静态资源字节核验通过；本机 Agent 保持 ce22d38 的已验证运行二进制，并已启用 Terminal。实际版本、SHA-256、D1 绑定恢复、备份及未覆盖范围见 [2026-11-03 部署记录](CW_DEPLOYMENT_2026-11-03.md)。
