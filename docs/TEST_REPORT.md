# 测试报告

[文档索引](README.md) · [开发与复现命令](DEVELOPMENT.md) · [发布记录](DEPLOYMENT_STATUS.md)

0.6.0 源码 `4b164c6` 已通过下述本机回归及全部必需 CI，云端与四平台下载包已发布。现场原生服务未自动更新；准确制品与线上验证见 [发布记录](DEPLOYMENT_STATUS.md)。

## 历史优化阶段验证 · 2026-11-02（开发中）

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
