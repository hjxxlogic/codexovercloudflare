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

## 首批时的剩余审计和实施（历史快照）

尚未完成全部帧、全部持久列、所有业务入口及测试的逐项审计。S0 总门槛仍未关闭；本批仅覆盖上表相关调用链、正确性修复及局部调度公式收敛，不应标记全计划完成。未删除任何持久字段、协议帧、游标、信用或旧数据迁移。

后续必须补齐架构第 11.1 节完整矩阵，再决定控制证明重复字段、结果描述符重复字段、旧表/迁移及跨语言调度规则能否删并。仍需统一可靠操作接口、全局调度在途预算、共享错误分类及序列化 fixtures；一个 delay 函数不等于统一了整个恢复状态机。所有未证明候选保持原机制。S3–S5 未完成。

## 第二批：接收结果正文去重

已核对 CW delivery-results.ts 的全部实现及 delivery.ts 的保存/ACK/回调调用链，CC delivery_client.cpp 的 receive_result、receive 的回滚/落盘/ACK顺序，以及全仓库的结果 cache/buffer 消费者。cache 仅用于有界结果尾部与重复内容核对；未闭合缺口的结果必须由 buffer 保留，不需要同时存入 cache。

CW/CC 现在都在连续前缀推进时，将结果从 buffer 移到 cache。操作、连续水位、字节位置、原请求待办和正文仍由原有同一持久提交保存，提交后才发送 ACK/触发业务回调。崩溃前后分别得到旧或新快照，不出现水位前进而正文未提交的中间态。transfer 全文验证条件不变。cache 仍受 64 项/2 MiB 上限约束，buffer 仍受 100 项/2 MiB 上限约束，不删除未知结果或增加可用信用。

已有账本无需迁移；如果旧 cache 和 buffer 同时含有同一结果，在该结果进入连续前缀时移除旧 cache 副本再追加一次。未闭合缺口时暂时保留既有布局，避免启动时新增写入或破坏原恢复状态。新写入的乱序结果只占一份持久正文。cache 淘汰顺序改为结果连续序号顺序，与 buffer 的未确认保留责任分离。没有改变 wire、schema、结果确认事实或 Worker 责任。

确定的收益是消除新乱序结果在账本 JSON 内的第二份正文/描述符/transfer 全文；具体减少量等于这些原重复记录的编码大小，不据此推断生产 RSS、磁盘硬配额或云端费用。未新增层或第三套缓存。

## 第三批：恢复拒绝分类唯一来源

审计发现同一组六种错误在 deliveryResetSchema、HostRelayDO.complete 的 delivery 分支和 CW refreshOnce 的 HTTP 异常分支分别硬编码。三处都表示当前恢复交换必须停止，分类完全一致；不涉及业务执行未知终态与普通 API 重试分类。

现由 packages/protocol/src/delivery.ts 的 deliveryRecoveryErrorSchema 定义唯一集合，schema 和 stopsDeliveryRecovery 共用。Worker 仍须存在 exchangeId 才发 reset，仍在响应前鉴权；CW 仍先核验当前 connection generation/exchangeId 再冻结。没有改变错误码、错误正文、授权检查或转发/持久化责任。C++ 接收显式 reset 的路径没有这份重复列表，本批不人为增加另一份。

测试将真实 HostRelayDO 的原单一拒绝场景扩为十种错误：六种终止恢复错误发 reset；RESULT_UNKNOWN、RESULT_PENDING、BACKPRESSURE、HOST_OFFLINE 发普通错误，不改变原请求恢复资格。验证交换 ID 绑定及没有云端业务持久回执。全套 26 文件/413 项 Vitest、TypeScript、协议生成检查及 lint 通过；本批未改 C++，不重复原生构建。完整 S0–S5 仍未完成。

## 第四批：结果查询和摘要的重复计算

审计 Agent.control(delivery)、Store.delivery_results/result_ack/result_state、credit 释放路径及真实端点测试后，保留第一次 delivery_results 的水位回退校验和所读结果页，ACK 后直接移动该页到响应；不再第二次查询并构建同一后缀页。Agent 同步控制段内没有异步让出；ACK 仅回收 resultSeq≤received 的前缀，页查询仅返回 resultSeq>received 的后缀。ACK 校验/提交失败仍不返回成功响应，窗口仍在 ACK 后重新取得。没有删除在线 ACK 与恢复快照的不同规则，新增真实 Agent 断言恢复快照回退仍被拒绝。

transfer 描述符的 contentId/digest 本来由同一个固定 full_body 分别计算 SHA-256；现在仅计算一次供两个字段复用。字段、字节编码、内容校验和保留周期不变；没有为了删除 wire 字段引入版本迁移。每个相关恢复请求减少一次结果头读取/幂等写入及结果页查询/JSON 构建，每个 transfer 结果减少一次全文 SHA-256。未宣称生产延迟或费用收益。

## 第五批：原生恢复策略收敛及跨语言样例

原生 CLI 的原请求发送/确认、历史连接、HistorySubscription、Agent 历史通知与 TUI 信用恢复复用 recovery.hpp 的延迟策略；CLI 两处相同的可恢复错误集合也共用一个判定。三次/五次快速尝试和 30–60 秒慢速区间保留。attempt 达阈值后饱和，避免长期运行计数回绕；延迟为运行时派生状态，不新增持久字段。慢速抖动统一为毫秒级均匀采样，随机数仅用于调度，不用于身份/权限。Agent 连接准入的退避有不同生命周期，未强行改成可靠待办的无限恢复策略。

C++/TS 共用 recovery-delay-fixtures.json，涵盖快速阈值、10 秒快重试上限、慢速区间端点和最大 32 位计数。停止、同伴锁、在途限制、信用查询、对原结果确认等仍由既有适配器负责；公共延迟策略不拥有业务执行资格。CLI 诊断输出改为毫秒。不同业务适配器保留并非未完成的重复调度器重写，不引入通用工作流框架。

## 第六批：持久派生字段及旧启动回填

全仓库读写引用核对结果：control.ready 只由 control_apply 固定构造，内容完全等于 epoch/control_id/owner 与 transport2_identity.instance；command_keys.digest 没有读取者，重复 command_digests 中同一 stream/seq 的摘要。两列已删除，前者按权威列构造确认，后者保留 request_id→seq 唯一键与独立命令摘要。控制权切换事务、跨控制代际的旧 owner 快照、关闭拒绝边界全部保留，不能把旧 flow_owner 从当前控制主体推导。

新库直接使用精简布局。已有 delivery:2 库在原启动事务内校验冗余副本一致性后重建两张表；不用依赖较新 SQLite 的 DROP COLUMN。索引唯一性与记录完整复制。副本不一致/摘要缺失时拒绝启动并回滚，包括已经完成的另一张表转换；不选一份静默覆盖，也不重建执行资格。控制确认与存储实例不符时同样拒绝。转换后不再进入转换分支，原生程序降级不支持，必须使用匹配备份。

删除启动时遍历所有未清理命令、重新解析正文/两次计算摘要并 INSERT OR IGNORE 的旧回填。现行接收事务已同时保存命令、原请求键和命令摘要，崩溃不会只提交正文；正文清理保留这些身份，旧业务状态不导入。不存在以回填复活旧命令的兼容路径。正常重启不再扫描正文做此回填；执行 started/received 的重启终结与完成日志恢复仍保留。

新测试构造原 layout，验证字段删除但控制证明/原请求键不变、重启幂等，以及控制实例冲突与摘要冲突均回滚全部 DDL/数据。实际数据文件未被本次开发命令修改，转换仅在隔离测试库演练。阶段记录中“待证明 ready 候选”的结论由本节替代。

## 第七批：共享原语收尾

网页历史订阅也接入 recoveryDelay，保持首次/ACK 的固定请求身份、跨标签页检查点事务与停止条件。HTTP 原请求意图仍按原 canonical 键顺序序列化，但 SHA-256/十六进制编码复用 deliveryDigest。原生配置文件原文 revision 与操作 fingerprint 复用 delivery_digest，保持逐字节摘要；不将原文摘要替换为规范化对象摘要，不重新编码已发布命令。

文件上传的二进制 SHA-256 与上述字符串摘要的数据类型不同，保留独立适配；连接准入和尽力通知的有限重连保留原策略，不强行套用有持久待办才无限慢速恢复的语义。没有创建新的框架或持久状态。

## 第八批：删除派生关闭游标

transport2_namespaces.closed_through 的唯一消费者是 delivery_budget 诊断；写者仅 delivery_close。每个分配在事务中增加 allocated 并保存唯一 scope/serial 的 credit，关闭只更新墓碑，所有信用身份受 flow_limit 限制且不会删除。因此同一 SQLite 查询快照内，最小未关闭 serial−1（无未关闭流时 allocated）在正常运行、正文回收及重启后均与原值等价。不从正文或内存计数推导，不改变信用右边界或重新开放旧身份。

删除该持久列及每次关闭的更新语句，预算输出字段保持原样。旧库先比较原值与推导值，一致才在已有启动事务中重建；不一致抛 STORAGE_CORRUPT，连同控制/请求键的转换全部回滚。测试覆盖原关闭缺口、关闭最后一流、重启推导、冲突拒绝及三张表转换回滚。查询只扫描有界分配元数据，沿用 scope/serial 唯一索引，不新增缓存或持久统计。

第八批验证：原生完整构建、8 项 CTest、27 文件/414 项 Vitest、真实 Agent delivery 故障回归及 C++ 格式检查通过。

## 本轮收口

第八批之后的最终候选决定、完整表字段组及 wire/业务入口矩阵见 [最终决策矩阵](TRANSPORT_SIMPLIFICATION_DECISIONS.md)。上文各批“尚未完成”是当时范围记录，由最终矩阵及架构 11.6 的结果替代。保留的必要状态、事务物化计量和独立生命周期不再列作未实施删除项；不为追求帧/字段数量而引入版本切换或改变故障语义。最终本机验证集中记录在 TEST_REPORT，生产发布仍未执行。
