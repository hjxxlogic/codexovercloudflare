# 测试报告

[文档索引](README.md) · [开发与复现命令](DEVELOPMENT.md) · [发布记录](DEPLOYMENT_STATUS.md)

0.6.0 源码 `4b164c6` 已通过下述本机回归及全部必需 CI，云端与四平台下载包已发布。现场原生服务未自动更新；准确制品与线上验证见 [发布记录](DEPLOYMENT_STATUS.md)。

## 历史优化阶段验证 · 2026-11-02（开发中）

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
