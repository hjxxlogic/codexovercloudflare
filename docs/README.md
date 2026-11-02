# 文档索引

本目录区分当前使用说明、设计依据、验收结果和历史证据。**0.6.0 已于 2026-11-01 发布云端及四平台下载包**：delivery:2 和协议简化通过本机回归与六项必需 CI。现场 Agent / CLI 仍需手动升级。线上版本不能从源码版本推断，请查[发布记录](DEPLOYMENT_STATUS.md)中的日期与制品身份。

## 按任务阅读

| 要做的事             | 阅读顺序                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 安装、连接和日常使用 | [用户手册](USER_GUIDE.md) → [远程配置与重启](REMOTE_CONFIGURATION.md)                                                                  |
| 开发或复现问题       | [开发说明](DEVELOPMENT.md) → [当前测试报告](TEST_REPORT.md)                                                                            |
| 理解端到端可靠性     | [现行传输协议](RELIABLE_TRANSPORT.md) → [状态与资源盘点](TRANSPORT_STATE_INVENTORY.md) → [传输架构](TRANSPORT_ARCHITECTURE.md)         |
| 评审协议简化         | [最终决策矩阵](TRANSPORT_SIMPLIFICATION_DECISIONS.md) → [分批审计记录](TRANSPORT_SIMPLIFICATION_AUDIT.md) → [验收结果](TEST_REPORT.md) |
| 准备发行或回退       | [发行流程](RELEASE.md) → [0.6.0 切换方案](TRANSPORT_CUTOVER.md) → [已执行的发布记录](DEPLOYMENT_STATUS.md)                             |
| 理解项目与权限边界   | [项目需求](REQUIREMENTS.md) → [总体架构](ARCHITECTURE.md) → [多项目设计](multi-project-design.md)                                      |

## 当前参考文档

| 文档                                                                        | 职责与阅读边界                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [USER_GUIDE](USER_GUIDE.md)                                                 | 使用步骤、命令、配置与故障处理；先看安装和使用，版本补充位于后部         |
| [DEVELOPMENT](DEVELOPMENT.md)                                               | 工具链、构建与测试方法；列出命令不表示该检查已运行                       |
| [REQUIREMENTS](REQUIREMENTS.md)                                             | 功能目标和硬约束；带版本的旧基线不能覆盖现行协议                         |
| [ARCHITECTURE](ARCHITECTURE.md)                                             | 组件、运行时、存储与授权设计；含设计演进记录                             |
| [RELIABLE_TRANSPORT](RELIABLE_TRANSPORT.md)                                 | 当前 delivery:2 的可靠性契约和故障边界                                   |
| [TRANSPORT_ARCHITECTURE](TRANSPORT_ARCHITECTURE.md)                         | 权限/端点责任划分、实施计划及简化阶段结果                                |
| [TRANSPORT_STATE_INVENTORY](TRANSPORT_STATE_INVENTORY.md)                   | 状态归属、资源上限和当前持久布局；历史阶段已单独标注                     |
| [TRANSPORT_SIMPLIFICATION_DECISIONS](TRANSPORT_SIMPLIFICATION_DECISIONS.md) | 每项帧、字段和机制的删除/保留决定及测试索引                              |
| [REMOTE_CONFIGURATION](REMOTE_CONFIGURATION.md)                             | 在线进程配置读取、替换、重启及原请求保护                                 |
| [multi-project-design](multi-project-design.md)                             | 单 Agent 多项目、管理员身份及文件系统边界                                |
| [cloudflare-access-coc-auth](cloudflare-access-coc-auth.md)                 | Cloudflare Access 入口和 CoC 业务授权的分工                              |
| [d1-relay-state](d1-relay-state.md)                                         | D1 目录/归档与在线 DO 状态分工；传输业务状态以当前协议为准               |
| [protocol.generated.json](protocol.generated.json)                          | 协议生成产物；修改源 schema 后运行 `npm run protocol:generate`，不要手改 |

## 待实施优化方案

- [CW 界面美化与工作台功能设计](CW_UX_DESIGN.md)：配色排版、高级 Markdown（公式、Mermaid、脚注、提示块和目录）、文件浏览器、命令输出及交互式 Terminal；网页优先的分阶段实施与验收方案；已实现范围与限制见 [工作台验收](CW_WORKBENCH.md)，实际部署见 [发布记录](DEPLOYMENT_STATUS.md)。

- [历史存储与环形缓存优化](HISTORY_STORAGE_OPTIMIZATION.md)：本机容量调查、Codex 回源边界、Agent JSON 配额设计和分批实施门禁；尚未实现。

- [线上浏览器自动化测试](ONLINE_BROWSER_TESTING.md)：远程无图形界面初始化、人工验证码、管理员认证复用及隔离测试分层；真实登录与跨浏览器复用已验证，测试套件待实现。

## 验收、发布和历史证据

| 文档                                              | 用途                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| [TEST_REPORT](TEST_REPORT.md)                     | 最新本机与 CI 验收、对应提交和未验证范围                       |
| [DEPLOYMENT_STATUS](DEPLOYMENT_STATUS.md)         | 实际发布过的源码、CI、制品和生产验证；不等于实时线上状态 |
| [RELEASE](RELEASE.md)                             | 发布前检查、制品校验、更新与回退要求                     |
| [TRANSPORT_CUTOVER](TRANSPORT_CUTOVER.md)         | 0.6.0 隔离演练和现场原生升级步骤；方案不是部署证明     |
| [测试历史](history/TEST_REPORT_2026-11-01.md)     | 截至 2026-11-01 的阶段测试与旧版验收原始记录             |
| [简化审计过程](TRANSPORT_SIMPLIFICATION_AUDIT.md) | 八批变更、事务证明和各批当时范围；当前结论由最终矩阵汇总 |

以下专题保留当时的源码、测量与判断，不能将历史“待办”直接当成当前缺陷，也不能把历史性能数据当成本次变更收益。

| 专题                    | 历史材料                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 项目初始构想            | [IDEARS](IDEARS.md)                                                                                                                   |
| 2026-10-24 评估与稳定化 | [完整评估](audit-2026-10-24.md)、[网页 UI 评估](wc-ui-2026-10-24.md)、[实施记录](stabilization-2026-10-24.md)                         |
| 2026-10-25 性能         | [性能审计](perf-audit-2026-10-25.md)、[修复与验证](perf-fixes-2026-10-25.md)                                                          |
| DO 成本与用量           | [计费优化](do-billing-optimization-2026-10-26.md)、[实际用量](do-usage-2026-10-27.md)                                                 |
| D1 / DO 状态演进        | [存储审计](relay-storage-audit-2026-10-29.md)、[活动会话方案评估](d1-active-session-review.md)、[D1 使用分析](d1-usage-2026-10-31.md) |

`assets/` 保存可公开的截图、测量和发布证据；凭据、私有备份及本机临时日志继续放在忽略目录，不纳入文档归档。

## 文档维护约定

- 行为与操作写入对应参考文档；测试结果写入 TEST_REPORT；真正执行发布后才更新 DEPLOYMENT_STATUS。
- 架构计划中的“设计”“实现”“本机通过”“CI 通过”“已部署”分别标注，不互相代替。发生冲突时回查指定源码和实际验证证据，不按文件名或更新时间猜测。
- 当前协议语义以 RELIABLE_TRANSPORT 为入口；资源数值集中查状态盘点，简化取舍集中查最终决策矩阵，避免继续复制阶段进度。
- 新增专题时更新本索引。移动文件须同步相对链接；保留仍被引用的标题锚点和证据。历史报告按日期放入 `history/`，不把未完成记录改写为当时已完成。

- [CW 工作台实施与验收](CW_WORKBENCH.md)：高级 Markdown、文件浏览及 Linux 交互终端的实现边界和验证。

- [CW 工作台本机构建部署（2026-11-03）](CW_DEPLOYMENT_2026-11-03.md)：菜单与分隔条上线、本机 Agent 升级和 Terminal 启用、D1 故障恢复及本次跳过 CI 的明确边界。

- [CW 线上刷新耗时与优化方案（2026-11-03）](CW_REFRESH_PERFORMANCE_2026-11-03.md)：真实按钮分段采样、HTTP 结果回收成本及网页优先的优化路径。
