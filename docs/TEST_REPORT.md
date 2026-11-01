# 测试报告

[文档索引](README.md) · [开发与复现命令](DEVELOPMENT.md) · [发布记录](DEPLOYMENT_STATUS.md)

当前源码为 0.6.0 本地候选，以下为协议简化后的最新本机验收。测试通过不代表已发布，也不代表远程 CI 或其它平台通过。

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
