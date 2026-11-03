# A / C 可靠传输协议（delivery:2）

本文描述 0.6.0 本地候选。唯一业务版本为 `delivery:2`；缺失、旧版或未知版本在业务处理前拒绝，不降级。原生构建 / 更新清单的 `protocol:1` 仅用于发行更新兼容，不代表旧业务可用。实施证据与完成里程碑分别见 [测试记录](TEST_REPORT.md) 和 [架构计划](TRANSPORT_ARCHITECTURE.md#82-按顺序执行的工作项)。

Worker 持久保存授权、撤销、租约和控制代际；业务正文、结果、发送头、ACK、信用与补发日志由 A / C 保存。Worker 只提供有界尽力转发，重建可丢失全部临时关联。连接成功和 HTTP 成功不能代替端点持久确认。

## 开发中：项目终端通道

`POST /api/v1/hosts/:host/terminal` 的 `info/open/read/input/resize/close` 只开放给 Web 凭据。除 info 外，均绑定 projectId、sessionId 与完整 control proof；read/input/resize/close 还绑定 terminalId。Relay 验证当前项目 writer 及账号，Agent 独立验证持久控制代次、运行时连接代次和归属。

open/close 属于可靠 HTTP 业务写入口，沿用原 requestId、Agent deliveryInstance 和端点操作账本。输入与缩放属于独立易失 PTY runtime 的有序流：正安全整数 seq 从 1 连续递增，只保留最近一项摘要；完全相同的上一项可返回原 next，失序/不同内容拒绝。单次输入最多 4096 解码字节；部分 write 或结果不确定不能换身份重放，runtime 会终止。浏览器错误后冻结输入，显式重新连接按已渲染 offset 接续尚存 runtime，不恢复旧按键。

read 使用非负字节 offset，返回 base64 data、下一 offset、more、gap、exited/exitCode 与 next。每次最多 32 KiB，保留最近 256 KiB；缺口不重建历史，也不伪造完整日志。输入/输出不注册成 delivery:2 会话正文，不新增 delivery:2 持久 ACK 或云端进度。detach、控制代次变化、会话结束或 Agent 断开终止终端，60 秒无授权读取 / 流式活动也终止；进程状态不可从浏览器缓存恢复。详见 [工作台实现](CW_WORKBENCH.md)。

### streaming:1 扩展

新版网页使用独立 `GET /ws/v1/hosts/:host/terminal` 字节流；原 HTTP read/input/resize 保留给兼容端点，但新版浏览器不再轮询。bind 固定 projectId/sessionId/terminalId/control/offset，input/resize 继续使用 runtime seq；ready/ack 确认 next，output 携带 base64、结束 offset 和 gap，输出 ack 确认已渲染位置。Agent 每帧至多发送 16 KiB，最多 64 KiB 未渲染，256 KiB 缓冲接近满时暂停 PTY read；不得用发送成功替代渲染完成。输出 ACK 和心跳不落盘，不能确认或推进 delivery:2 业务日志。具体 schema 为 terminalStreamClientSchema / terminalStreamServerSchema。

纯字节流断开后保留 runtime 到原 60 秒空闲上限，按浏览器已渲染 offset 重新绑定；Agent 重启不可恢复，按键只在内存排队，不复用或重发未确认输入。控制权撤销与代次变化继续拒绝旧流，浏览器冻结输入。open/close 原可靠 HTTP 语义及 Linux 隔离不变。

## 原请求与控制权

非会话窗口的创建 / 停止、外部排队 / 审批、项目修改及上传 begin / finish，首次网络发送前保存完整固定意图、原 requestId 和 Agent 存储实例。HTTP 使用 `Idempotency-Key`、`X-CoC-Operation-Instance`，确认另带 `X-CoC-Operation-Ack: 1`；owner 由 Worker 鉴权绑定。A 执行前提交 started，终态先落盘再回复，C 保存原终态后才确认。回包或确认丢失只重查原意图；重启后 started 固定为 RESULT_UNKNOWN，不派发新副作用。已确认正文可回收，永久拒绝身份不重新开放。

会话控制使用持久 controlEpoch / controlId / owner，连接代际另行绑定。接管分配 pending 即拒绝旧端新写入；A 提交新代际并终结旧 received 命令后才返回匹配 exchangeId 的 CONTROL_READY。C 等待当前两 lane 的确认再发送。旧 started 工作保持原真实状态，接管回执不表示它已停止。

## 命令与接收信用

C 先持久保存正文；未发布项 seq / end 为 0，不上网络。取得信用后，在一次本地事务内固定序号与 UTF-8 累计字节位置，再发送。OPEN 使用固定流身份和本次唯一 exchangeId，normal / priority 两个快照齐备前暂停发布；旧连接和旧交换不能覆盖当前状态。

窗口携带 instance、streamSerial、creditGeneration、received / receivedBytes、credit / byteCredit。命令、查询、结果确认及正文读取必须携带原分配证明；实例或信用代际变化停止自动重放。首次 OPEN 无分配证明时只能确认结果位置 0，不能夹带结果查询。ACK 向前必须匹配已发布项边界，同序号不能更改字节位置；在线迟到 ACK 不回退状态，当前恢复快照的真实回退才冻结。

A 在公告信用前持久预留正文、结果和元数据空间。重复不重复计费或执行；received → started 是副作用派发边界。结果尚未确认时继续占用预留。normal 不能借用 priority / 恢复保留。流退役先拒绝旧代际，再回收未消费空间；有界拒绝记录不能压缩时停止分配，不删除最后的拒绝边界后放行旧流。

## 取消与审批

取消固定原实例、主体、controlEpoch、流和请求；已开始任务另固定 turnId。未知目标先保存取消标记，迟到原命令仍补齐传输序号并形成 CANCELLED_BEFORE_START，不启动任务。已发布项不能直接删掉制造缺口，不能取消任意当前或下一任务。取消接收回执不冒充 turn/completed。

审批绑定原 Agent / runtime / request ID / approvalVersion，重复原请求沿用原版本；未解决 ID 被改用于不同内容时关闭对应运行时。所有允许列表、沙箱及显式授权边界继续生效。外部审批溢出只断开本工具转发，原 app-server 保留待决，不自动授权或拒绝。

## 结果与正文

每 lane 有独立完成顺序 resultSeq，与 commandSeq 分离。C 有界缓冲乱序结果，保存连续结果、原请求终态与必要正文后才推进 RESULT_ACK。A 仅回收该完成前缀，不能按较大命令序号删除其它结果。

- `transfer` 描述符固定 revision、UTF-8 长度和 SHA256。C 取齐、校验并持久保存全文后才确认；A 在此之前保留全部分块，正常运行不以 TTL 清理未确认正文。
- `history` 不可变引用随任务终态的 `result.history` 保存，固定 agentInstance、sessionId、seq、revision、UTF-8 length 与 SHA256，contentId 等于 digest。保存引用即可确认；ACK 不删除权威历史。按需 content 读取携带原 reference；原修订已变或明确清理后返回 CONTENT_UNAVAILABLE，不使任务重新变为待执行。普通可更新历史视图仍可请求最新修订。

CC RPC 输出先保存正文和连续接收位置，再确认并交给 TUI；TUI 消费后才推进接收信用，未消费正文不能作为普通缓存淘汰。权威历史使用独立的持久订阅身份、修订游标和确认，先保存页面再确认；多个订阅者互不代替。清理另一进程 / 标签页的订阅后，迟到回包不能重建旧身份或继续确认。

## 恢复与资源

有未确认工作时，有限快速恢复后转为每对端 30–60 秒抖动的合并慢速恢复；空闲不新增恢复轮询。断线、程序退出或关页保留待办，重新运行后沿原身份继续。撤销、实例冲突、存储失败、显式暂停或终结流停止发送。结果不明不自动新建意图。

预算同时约束条数、字节、单流 / 会话和全局占用；逻辑计量包含记录与封装开销，不能当作 RSS 或物理磁盘硬配额。进程、RPC、Web 队列、审批、上传、项目、管理请求及 Worker 收发 / 鉴权集合也有独立边界。具体数值见 [统一资源盘点](TRANSPORT_STATE_INVENTORY.md#当前统一资源盘点与本机测量) 和 native/include/coc/credit.hpp。磁盘或 I/O 失败时拒绝新副作用且不虚报落盘成功，不丢已确认数据。

新可靠状态使用独立命名空间；旧 outbox、业务 receipts 和游标不导入。配置、凭据、项目与权威历史保留并独立备份。写入新版状态后不自动降级交给旧程序读取；升级 / 切换步骤见 [发行说明](RELEASE.md)。

创建会话在保存 session 的同一 SQLite 事务内，向原操作结果槽保存包含 sessionId 的恢复证据。初始化期间仍为 RESULT_PENDING，禁止提前确认；该期间崩溃后，原请求返回带 sessionId 的 RESULT_UNKNOWN，可核对原会话，不自动再次创建，也不表示初始化成功。已有真实终态仍返回原终态。

CW/CC 未闭合缺口的结果正文只进入持久 buffer；连续前缀推进时在同一提交中移入有界结果 cache，不重复持久保存正文。旧账本已有副本在缺口闭合时一并压缩，确认及 transfer 正文保留条件不变。

恢复拒绝错误由共享 deliveryRecoveryErrorSchema 定义；Worker 的 reset 分类和 CW HTTP 恢复停止条件复用该定义。传输未知、结果待定、背压与主机离线不属于 reset 分类。当前交换/连接校验仍先于冻结状态转换。

Agent 恢复响应复用 ACK 前经过水位校验的结果后缀页；ACK 只回收该水位及以前的前缀，响应窗口仍在 ACK 后读取。大结果描述符的 contentId/digest 复用一次固定正文摘要计算，wire 与保留语义不变。

原生恢复延迟共用 recovery.hpp，CW 与原生使用共享样例约束快速阈值及 30–60 秒慢速范围。重试计数在进入慢速阶段后饱和；持久请求和权限校验继续决定是否允许重试，计时器不成为持久状态。

控制确认由持久代际/主体/控制身份及 Agent 实例构造，不再另存 ready JSON；命令请求键表不重复保存摘要，摘要表仍在正文回收后用于拒绝内容冲突。已有 delivery:2 布局通过启动事务校验并转换，不导入旧业务或重放待办。

网页历史订阅与命令/HTTP/上传共用恢复延迟策略；原请求 canonical JSON 和配置原始字节仍使用各自固定的序列化语义，只共享 SHA-256 实现，不改变任何已保存摘要。
