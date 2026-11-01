# 协议简化审计与实施记录

2026-11-01。当前是阶段性记录，不是 S0–S5 全部完成声明。仅本机，不发布部署。

## 已核实的边界

| 对象 | 源码与结论 | 处理 |
| --- | --- | --- |
| HTTP 原请求 | operations.cpp 按主体/原编号去重，started 在副作用前提交，ACK 清正文但不清身份 | 保留；不能与 Worker 临时关联合并 |
| 创建会话 | agent.cpp 原先先 save(session)，异步初始化后 operation_finish；store.cpp 重启覆盖 started 为通用未知，原编号无法定位已创建会话 | 优先修复：会话与恢复证据同事务保存，复用现有 result 槽；运行中不返回该证据作为终态 |
| 客户端操作 | local_operations.cpp 与 operations.ts 的 pending/completed/confirmed 分别表示等待结果、结果已落盘、对端已确认 | 保留三态，结果存在不能推导 confirmed，确认后结果可能被尾部回收 |
| 命令与结果 ACK | delivery.cpp 的 received 与 result_heads.acked 对应不同日志、完成次序和回收边界 | 保留；命令完成顺序不能代替 resultSeq |
| 控制证明 | control_apply 将控制切换和旧未开始命令终结同事务提交；control_state 的 ready 与列存在重复表达 | 列为后续候选，尚未证明所有旧库存储与恢复消费者，不删列 |
| 信用 | credit.cpp 持久预留、关闭及释放；delivery_window 的右边界不会因已回收正文减少 | 保留承诺；不是从当前正文总量可恢复的纯缓存 |
| 结果 | delivery.cpp 的 transfer 正文独立保留，客户端落盘后确认；history 引用不拥有正文生命周期 | 不合并保留类别；contentId/digest 仅是待证明候选 |
| Worker | transient-operations.ts 为有界内存关联，host.ts 将错误映射为 code/message/status | 保留临时关联；它不是业务恢复权威，不能将结构化错误扩展未经核验地当已支持 |
| 重试 | CW delivery、operations、uploads 各自实现相同快退避/慢抖动公式 | 收敛到 recoveryDelay；保留会话五次/HTTP与上传三次快速预算，各自暂停、在途锁、恢复动作不变 |
| 序列化 | delivery 正文固定字符串；HTTP 意图使用规范化对象摘要 | 不改 wire，也不假设两种摘要语义等价 |

## 创建崩溃一致性

`operation_session` 仅允许已有 started 操作且尚未分配 session；在一个 SQLite 事务中保存 session 和错误形式的恢复证据。该证据只描述已分配的 sessionId，不描述外部线程初始化成功。operation_begin 在 started 时不返回 result；operation_ack 仍拒绝 started。成功初始化后原有 operation_finish 替换恢复证据为真实终态；重启将 started 改为 unknown，并保留已有恢复证据，无证据的历史记录仍使用原通用未知错误。不增加表、迁移或资源预留，证据占现有操作槽。

当前通过既有错误 message 传回 sessionId，确保 Worker 的 code/message 映射及客户端显示不会丢失它；未新增机器可读错误字段。原会话运行时重启后仍按现有策略终结，不能通过找回身份宣称运行时恢复。ACK 后服务端正文依原规则回收，本地已持久结果仍负责保存该证据。修复前已经产生且没有关联的 unknown 不能凭空恢复。

失败路径不得在关联事务回滚后另存 failed session，避免创建无原请求关联的孤儿。测试通过 SQLite trigger 注入结果写入失败，检查 session 同时回滚；另覆盖同编号二次分配、运行中查询/提前确认、重启和真实 Agent SIGKILL。

## 剩余审计和实施

尚未完成全部帧、全部持久列、所有业务入口及测试的逐项审计。S0 总门槛仍未关闭；本批仅覆盖上表相关调用链、正确性修复及局部调度公式收敛，不应标记全计划完成。未删除任何持久字段、协议帧、游标、信用或旧数据迁移。

后续必须补齐架构第 11.1 节完整矩阵，再决定控制证明重复字段、结果描述符重复字段、旧表/迁移及跨语言调度规则能否删并。仍需统一可靠操作接口、全局调度在途预算、共享错误分类及序列化 fixtures；一个 delay 函数不等于统一了整个恢复状态机。所有未证明候选保持原机制。S3–S5 未完成。
