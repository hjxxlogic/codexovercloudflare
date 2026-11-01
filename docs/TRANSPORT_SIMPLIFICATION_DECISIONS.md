# 通信简化最终决策矩阵

2026-11-01；与 `TRANSPORT_SIMPLIFICATION_AUDIT.md` 的八批实现记录配套。审计基线为各批父提交，实现证据为各批提交及 `TEST_REPORT.md` 的本轮验证。下列“保留”是本轮确定决策，不是待实施删除清单；没有证明跨事务等价的机制不合并。本轮不改变 delivery:2，不增加兼容协议，不发布部署。

## 线协议和字段

权威定义为 `packages/protocol/src/{index,delivery,management}.ts`，实际收发为 `apps/relay/src/host.ts`、`native/src/agent.cpp`、`apps/web/src/delivery.ts` 与 `native/src/delivery_client.cpp`。生成 schema、原生 validator 与共享 fixtures 一起核对；以下区分真正的帧和嵌套结果，不能将概念 CONTROL_READY 当成独立新帧。

| 实际消息/字段                                                             | 确认与保留作用；决定                                                                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delivery-open                                                             | 首次分配和恢复共用；exchangeId 排除旧连接响应，received/receivedBytes 捎带持久结果水位，allocations 固定原分配；保留，无需 RESUME                                                  |
| delivery-command                                                          | seq/end/body 是固定原命令及两种资源边界；stream/lane/instance/streamSerial/creditGeneration 共同约束执行资格；保留                                                                 |
| delivery-receipt                                                          | 无后续业务时仍能确认最终结果，不能只允许 OPEN 捎带；保留                                                                                                                           |
| delivery-query                                                            | 按原命令查执行结果；与按 resultSeq 取完成前缀不同，未知结果不得新编号执行；保留                                                                                                    |
| delivery-content 请求                                                     | resultSeq/offset 分块取 transfer 正文；与不可变 history 引用分离；保留                                                                                                             |
| delivery-window                                                           | 接收连续头/信用及结果完成头；closed/exhausted 阻止在已退休/容量耗尽的分配上继续发布；保留                                                                                          |
| delivery-result                                                           | seq 关联命令，resultSeq/resultEnd 是独立完成顺序，resultStream 排除跨流结果，resultBody/resultDigest 校验固定结果；保留                                                            |
| delivery-reset / delivery-rejected                                        | 前者终止指定 exchange/lane 恢复，后者报告投递拒绝；不是已提交的业务结果；保留，六种恢复拒绝码改为 TS 唯一来源                                                                      |
| delivery-output / delivery-data                                           | CC 输出消费信用与 A 持久输出；不能拿命令/结果确认替代消费位置；保留                                                                                                                |
| delivery-ready / attached / auth                                          | 连接准入及 ticket 附着，不代表 A 已提交控制代际；保留                                                                                                                              |
| 控制证明 owner/controlId/controlEpoch/instance                            | A 提交后在恢复结果中确认；Worker 核验后激活，C 等待匹配证明；只删除 A 的重复 ready JSON 持久列                                                                                     |
| transfer/history 的 delivery-content 描述符                               | retention 决定 ACK 后能否回收；revision/length/digest 防止分块混合；contentId 与 digest 现相等，但删 wire 字段需新版本及所有消费者切换，本轮收益不足以承担此复杂度；仅合并摘要计算 |
| history subscribe/ack/retire/page/content                                 | 有状态订阅、持久确认、永久退休、分页和正文读取各有独立语义；保留                                                                                                                   |
| history-ready/history-notice/history-detached 及历史响应                  | 路由准入、修订唤醒、断开及数据交换；notice 不拥有正文，不替代持久修订对账；保留                                                                                                    |
| control/result，web/rpc，notice/event                                     | Worker 到 A 的认证路由封装与端点 payload；控制 result 使用临时 wire，业务 result 使用原身份；不可用前者代替后者                                                                    |
| receipt/receiptId                                                         | Worker 连接转发的条数/字节背压确认，不证明端点持久落盘，与 delivery-receipt 的结果回收不同；保留                                                                                   |
| capabilities/hello，ping/pong，detach                                     | 版本与能力拒绝、连接存活和路由拆除；不属于重复业务恢复握手；保留                                                                                                                   |
| management-register/management-ready/management-request/management-result | 管理员独立通道，配置 read/replace/restart 校验原编号与 revision；保留                                                                                                              |
| projects-changed/change/subscribed                                        | 尽力失效通知，权威列表可重新读取；不增加可靠业务回执                                                                                                                               |
| web ack/error 与 HTTP error                                               | ack 是业务回包，error 的业务未知、临时关联丢失、权限拒绝不能机械合并；保留原错误语义                                                                                               |
| delivery 版本与发行 protocol:1                                            | 前者必须是 2，未知/缺失在业务前拒绝；后者服务旧更新器读取发行清单，不是旧业务降级                                                                                                  |

## 持久表及字段分类

除下文明确写“派生删除/物化保留”外均为必要状态。表名省略 `transport2_` 前缀（sessions/events/history/bodies/chunks/streams/external_items/cache 除外）。主键及唯一索引属于身份约束，不能以“可哈希得到”删除。正文可回收不意味着身份可删除。具体固定上限沿用 `credit.hpp` 和状态盘点，不新增第二个预算权威。

| 表与字段                                                                                             | 读写者、恢复/清理边界和结论                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity(id,instance)                                                                                | Store 启动；持久库身份，换库不能重绑原请求；必要                                                                                                    |
| operations(key,owner,request_id,digest,phase,result,reserved)                                        | operations.cpp、Agent；started 在副作用前提交，终态后可查，ACK 清正文但留身份；创建 session 与临时恢复证据同事务；必要                              |
| uploads(key,owner,digest,phase,result,reserved,active)                                               | uploads.cpp；active 是未解除的磁盘承诺，unknown 不证明临时文件已回收；必要，不从 phase 推导                                                         |
| local_operations(key,allocation,value)                                                               | local_operations.cpp、CLI；value 的 requestId/path/body/instance/digest/state/receipt/result 固定意图及确认阶段；confirmed 后可裁正文尾部，身份保留 |
| outputs(stream,seq,end_bytes,body)                                                                   | delivery.cpp；正文持久接收和消费分离，清理不允许丢未确认输出                                                                                        |
| output_heads(stream,sent,sent_bytes,published,acked,acked_bytes)                                     | 发布上界和已确认前缀在正文删除后仍必要；不能从剩余 outputs 求和重建                                                                                 |
| output_budget(stream,bytes,records)                                                                  | 与正文同事务更新的物化计量；派生但保留以限制每次操作扫描开销，不独立授信                                                                            |
| streams(stream,session,received,received_bytes,slots,bytes)                                          | delivery.cpp；命令连续接收边界与配置窗口；正文回收后仍必要                                                                                          |
| commands(stream,seq,end_bytes,body,phase,result)                                                     | delivery.cpp、Store 重启恢复；received/started/terminal 不等价，result 参与重建完成日志；不能仅因 results 存正文而删除                              |
| control(session,epoch,control_id,owner)                                                              | 控制提交事务；ready 派生删除，恢复用上述列+identity.instance                                                                                        |
| flow_control(stream,session,epoch,control_id,closed)                                                 | 每流权限快照与退休拒绝，control 切换不能覆盖旧流身份；保留                                                                                          |
| flow_owner(stream,owner)                                                                             | 旧流主体快照；不得从当前控制权 owner 推导                                                                                                           |
| command_keys(stream,request_id,seq)                                                                  | 原请求唯一键；digest 副本已删除，权威值在 command_digests                                                                                           |
| command_digests(stream,seq,digest)                                                                   | 正文清理后识别重复/冲突，永久有界身份；必要                                                                                                         |
| cancel(stream,request_id)                                                                            | 先到取消拒绝迟到命令；流退休才可释放；必要                                                                                                          |
| namespaces(scope,allocated)                                                                          | 持久分配序号；closed_through 派生删除，来自有界 credit 墓碑，不新增缓存                                                                             |
| credit(stream,session,lane,scope,serial,generation,reserved,credit,byte_credit,closed)               | credit.cpp；右边界承诺含未使用信用，关闭不清身份；恢复先重建承诺再授信，必要                                                                        |
| local_credit(key,kind,reserved)                                                                      | 本地可靠账本预留，不以当前正文大小回收未用承诺；必要                                                                                                |
| result_heads(stream,sent,sent_bytes,acked,acked_bytes)                                               | 完成前缀/字节累计；正文清理后仍必要                                                                                                                 |
| results(stream,seq,command_seq,end_bytes,body,digest)                                                | 独立完成序号；ACK 清前缀，命令执行顺序不能代替完成顺序；必要                                                                                        |
| result_content(stream,seq,body)                                                                      | transfer 全文直到安全 ACK；独立于结果描述符生命周期，必要                                                                                           |
| history_subscriptions(key,session,owner,stream,instance,serial,generation,received,published,closed) | credit.cpp、history_subscription.cpp；订阅身份、接收头、已发布上界和退休墓碑；必要                                                                  |
| cache(key,value)                                                                                     | Store/CC 缓存；可靠 value 有独立预留并在普通缓存清理中保留；不能整表视为可丢缓存                                                                    |
| cache_entries(key,scope,bytes) / cache_budget(scope,bytes,records)                                   | credit.cpp；同事务物化计量，派生保留，不是另一套信用                                                                                                |
| history_entries(key,session,bytes) / history_budget(scope,bytes,records) / history_meta(id)          | history_budget.cpp；触发器维护权威历史物化计量及初始化标记，派生保留；删除标记会反复全量回填                                                        |
| sessions(id,value)                                                                                   | 会话业务权威，不是传输副本；创建关联与会话同事务，结束/重启状态不可由连接状态推导                                                                   |
| events(seq,session,value,time) / history(seq,session,value,revision)                                 | 事件日志与可更新视图不同；订阅修订和不可变引用检查需要原边界；必要                                                                                  |
| bodies(seq,size,bytes) / chunks(seq,start,text)                                                      | 大正文分块及字符/字节计量；不可合并两种长度；必要                                                                                                   |
| streams(session,key,seq) / external_items(session,turn,item,seq,fingerprint)                         | 历史合并及外部条目去重，不是命令传输 stream；必要                                                                                                   |

### 客户端 JSON 与 Worker 状态

| 状态及字段组                                                                                                                            | 决定及事务边界                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CW/CC delivery：version/stream、normal/priority、claimId/controller/control、retired                                                    | 帐本版本与流、控制申请/确认及旧流身份；必要，接管不允许搬运未决副作用到新流                                                                      |
| lane：next/bytes/received/receivedBytes、receiver/receiverStream/streamSerial/creditGeneration、closed/exhausted、entries(seq,end,body) | 累计头不能从已清理 entries 重建；端点实例/分配证明不能从连接推导；必要                                                                           |
| cancelled/cancelledKeys                                                                                                                 | 正文尾部与永久取消拒绝身份不同，必要；不以裁剪诊断尾部重新开放取消                                                                               |
| results：连续头/字节、buffer/cache、原请求结果                                                                                          | buffer 持有缺口，cache 持有已连续的有界尾部；已改为迁移记录而非复制；水位/正文/待办原子保存后才 ACK                                              |
| HTTP journal：version/host/owner/order/records/paused                                                                                   | order 保存原公平顺序，records 按原编号查重；对象键序不能替代业务顺序。paused 持久保留冻结，不能重启自动放行                                      |
| HTTP record：requestId/path/body/digest/instance/state/result/receipt/meta                                                              | pending/completed/confirmed 不是重复状态；receipt 包括执行端认证身份；meta 是 UI 原操作关联；保留                                                |
| upload journal：version/records；id/host/project/path/size/overwrite/sha256/digest/chunks/instance/phase/result/error                   | sha256 是文件摘要、digest 是完整上传意图摘要；queued/uploading/finishing/completed/failed/unknown 有不同恢复动作；完整正文首发前落盘，未知不重开 |
| 历史缓存：实例、页面/正文/修订、订阅 received/acknowledged                                                                              | IndexedDB 事务提交后确认；本地已收和 A 已确认之间可丢 ACK，不能合并；普通清理保留可靠待办                                                        |
| 内存 attempt/deadline/windows/generation/exchangeId/in-flight                                                                           | 派生运行状态；不持久化，重启从账本恢复工作；合并相同延迟公式但保留连接代际屏障                                                                   |
| Worker leases 的 epoch/nextEpoch/owner/controllerId/previousControllerId/pending/active/expires 及 delivery 绑定                        | 控制平面必要状态；分配 pending 即隔离旧写者，失败不退回旧代际；不能用 A 的结果 ACK 替代                                                          |
| Worker agentEpoch/ticket/handshake/session-mode、Registry 授权及撤销                                                                    | 安全边界必要状态，失效需同时影响 HTTP/WS；保留                                                                                                   |
| permission-operation/permission-wire/due、生命周期 phase/token/复制位置                                                                 | 权限回执和 DO/D1 原子发布恢复；保留，不是业务可靠交付                                                                                            |
| Worker transient operations、management wire                                                                                            | 有界临时关联，丢失后端点沿原编号重查；不持久化业务结果，不承担重试执行                                                                           |
| 旧 send-head/receive-head/head-instance/operation/part/wire                                                                             | 业务读写已删除；备份复制拒绝过滤保留，避免旧数据复活，不是兼容执行分支                                                                           |

## 业务入口、调度与错误的最终决定

创建/停止/项目远程修改由 OperationClient/CLI 原请求账本和 Agent operations 共同实现 `durable intent → started → result → ACK`，不再另建生命周期框架。会话命令用同一投递账本；审批/中断保留 priority 与业务权限允许列表。上传 begin/finish 复用原请求模型，chunk/status 保留偏移与内容校验。配置 replace/restart 使用同一原编号契约，但配置文件原子替换与 SQLite 不同事务，必须保留 before/after revision 及重启前回执。projects.json 的本地项目操作也被本地 CLI 使用，不能删掉领域去重账本或假称与外层 SQLite 原子提交。

统一 C++/TS 快慢延迟策略与共享边界样例，不统一执行资格。网页原请求和上传已经共用 peer lock / 四个全站在途槽；delivery、历史、输出受各自固定资源域约束。再增加通用调度器将引入额外队列和取消层，不能减少必要状态，决定不实施。连接准入与尽力通知的有限重连不套用持久待办无限慢速恢复。

恢复拒绝码去掉三处重复名单；其余分类保留：网络/背压可重试，权限拒绝停止，实例/正文冲突冻结，业务终态持久保存，RESULT_UNKNOWN 不重做，RESULT_UNAVAILABLE/CONTENT_UNAVAILABLE 不重开，版本拒绝在业务前发生。错误名只有调用动作与保留条件完全相同才可合并，本轮没有另外证明等价的码。

保留 events→history 的权威数据迁移、预算初始物化和旧备份隔离；删除现行接收事务已覆盖的启动命令正文回填。新旧本地布局只做一致性校验后的原子精简，不导入旧业务待办；详见 RELEASE 的升级/回退要求。

## 收益和验收边界

确定收益：三列重复/派生持久状态删除；每次关闭少一次 UPDATE；正常启动少一次命令正文扫描/解析/摘要回填；恢复响应少一次同后缀查询/构建；transfer 少一次全文摘要；CW/CC 新乱序结果只持久一份正文；恢复错误集合与延迟公式各有共享来源。线协议帧数、业务往返和预算上限不变，不以代码行数冒充资源实测，也不声称生产费用/时延下降。

逐项故障与整体验证见 TEST_REPORT。SQLite 内的原子性不扩大到 Codex 进程或配置文件系统；外部副作用已经发生而终态未提交仍可能 RESULT_UNKNOWN。已修复创建分配 session 后原请求丢关联的窗口，但不承诺复活原运行时，也不能补造升级前不存在的关联。

## 决策与故障证据索引

以下测试覆盖对应状态组的行为，不把通过一项测试解释为所有可能故障的形式化证明。每批新增断点见审计记录。

| 决策/状态组                   | 实现入口                                                    | 回归证据                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三列精简与启动原子转换        | Store 构造、control_state、delivery_close/budget            | native/tests/store_compaction.cpp：旧布局一致转换、重复打开、三类冲突、全部 DDL 回滚；native-core：流关闭/预算                                                                |
| 原请求和创建关联              | operation_begin/session/finish/ack、Agent.control           | native/tests/operations.cpp、tests/native-operations.ts、native-cli-operations.ts：落盘失败、运行中查询、原编号冲突、SIGKILL、确认回收                                        |
| 控制证明、命令/完成日志、信用 | control_apply、delivery_receive/start/finish/result_ack     | native-core、tests/native-delivery.ts、web-delivery.test.ts：逆序完成、丢包恢复、取消、旧证明、窗口回退、信用拒绝                                                             |
| 乱序结果单份保留              | receiveResults、DeliveryClient receive_result/receive       | delivery-results.test.ts、web-delivery.test.ts、native-core：缺口补齐、重复正文冲突、持久提交后确认                                                                           |
| 历史引用与订阅                | history_reference、history_subscription、credit             | native-history-reference、native-history-budget、native-delivery、history-subscription.test.ts：修订失效、尾部丢失、收到/已确认分离                                           |
| 跨语言规则                    | protocol validators、recovery_delay/recoveryDelay           | protocol-fixtures.test.ts、native-core、recovery-delay.test.ts；共享 allocation、operation-intent、original-write、history-reference、upload-binding、recovery-delay fixtures |
| Web 账本/锁/缓存              | OperationClient、HistoryCache、deliveryIdentity             | web-operations、web-delivery-identity、web-api、browser-operations 与完整 E2E：持久首发、多标签页、重开恢复、普通缓存清理                                                     |
| 上传独立资源生命周期          | uploads.cpp、UploadClient                                   | native-uploads、web-uploads、browser-uploads、完整 E2E：完整正文先存、偏移重查、丢首块回复、暂停重开、逐字节校验                                                              |
| 项目/配置文件事务             | projects.cpp、remote_config.cpp                             | native-projects、projects-e2e、native-configuration：同编号恢复、版本冲突、重启前回执和资源限制                                                                               |
| Worker 路由/权限/背压         | HostRelayDO、transient-operations、host-lifecycle、Registry | transient-operations、relay-order、host-lifecycle、完整 E2E：丢临时关联、零业务进度写入、旧备份隔离、授权撤销、多主机多标签页                                                 |
| 全局资源与控制保留能力        | credit.hpp、runtime、IndexedDB 计量、Worker 收发队列        | native-runtime-budget、native-history-budget、native-core、native-delivery、relay-order：上限拒绝、预留释放、慢接收方与独立控制额度                                           |
