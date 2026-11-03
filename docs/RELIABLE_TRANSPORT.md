# A / C 可靠传输协议（delivery:2）

唯一业务版本为 `delivery:2`；缺失、旧版或未知版本在业务处理前拒绝，不降级。发行清单的 `protocol:1` 用于更新兼容，不表示支持旧业务。

Worker 持久保存授权、撤销、租约和控制代际；业务正文、结果、发送头、ACK、信用与补发日志由 A / C 保存。Worker 只提供有界尽力转发，重建可丢失全部临时关联。连接成功和 HTTP 成功不能代替端点持久确认。

## Terminal 字节通道

Terminal 创建和关闭使用可靠 HTTP 操作，绑定原 requestId 与请求准入代次；runtime 绑定稳定 Agent 实例、owner、project、session 和 control proof。

当前浏览器使用 `streaming:2` 独立 WebSocket：bind 固定 terminalId/control/offset，input/resize 使用连续 seq，ready/ack 确认 next，output 携带 base64、字节 offset 和 gap。输出 ACK 只在 xterm 渲染后发送，不落盘、不推进 delivery:2 日志。HTTP 仅提供 info/open/close；read/input/resize 返回 `UPGRADE_REQUIRED`，读写和 resize 均走字节流。

单次输入最多 4 KiB，每输出帧最多 16 KiB，未渲染输出最多 64 KiB，Agent 保留最近 256 KiB；压力传回 PTY。浏览器最多 32 帧 / 64 KiB base64 输入在途，未知按键不重放。独立流断开后 runtime 最多保留 60 秒恢复宽限，按已渲染 offset 接续，缺口明确报告；Agent 重启不能恢复。控制权丢失、会话结束或 Agent 上行断开清理终端。

## 原请求与控制权

非会话窗口的创建 / 停止、外部排队 / 审批、项目修改及上传 begin / finish，首次网络发送前保存完整固定意图、原 requestId、稳定 Agent 身份及请求准入代次。HTTP 使用 `Idempotency-Key`、`X-CoC-Operation-Instance`，确认另带 `X-CoC-Operation-Ack: 1`；owner 由 Worker 鉴权绑定。A 执行前提交 started，终态先落盘再回复，C 保存原终态后才确认。回包或确认丢失只重查原意图；重启后 started 固定为 RESULT_UNKNOWN，不派发新副作用。已确认正文可回收，在保留期限内拒绝原身份重执行；记录清理后由准入代次拒绝过期原请求。

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

- `transfer` 描述符固定 revision、UTF-8 长度和 SHA256。C 取齐、校验并持久保存全文后才确认；A 在保留窗口内保存全部分块；期限或压力清理后明确报告过期，不自动重执行。
- `history` 不可变引用随任务终态的 `result.history` 保存，固定 agentInstance、sessionId、seq、revision、UTF-8 length 与 SHA256，contentId 等于 digest。保存引用即可确认；ACK 不删除权威历史。按需 content 读取携带原 reference；原修订已变或明确清理后返回 CONTENT_UNAVAILABLE，不使任务重新变为待执行。普通可更新历史视图仍可请求最新修订。

CC RPC 输出先保存正文和连续接收位置，再确认并交给 TUI；TUI 消费后才推进接收信用，未消费正文不能作为普通缓存淘汰。权威历史使用独立的持久订阅身份、修订游标和确认，先保存页面再确认；多个订阅者互不代替。清理另一进程 / 标签页的订阅后，迟到回包不能重建旧身份或继续确认。

## 恢复与资源

有未确认工作时，有限快速恢复后转为每对端 30–60 秒抖动的合并慢速恢复；空闲不新增恢复轮询。断线、程序退出或关页保留待办，重新运行后沿原身份继续。撤销、实例冲突、存储失败、显式暂停或终结流停止发送。结果不明不自动新建意图。

预算同时约束条数、字节、单流 / 会话和全局占用；逻辑计量包含记录与封装开销，不能当作 RSS 或物理磁盘硬配额。进程、RPC、Web 队列、审批、上传、项目、管理请求及 Worker 收发 / 鉴权集合也有独立边界。具体数值见 [资源盘点](TRANSPORT_STATE_INVENTORY.md#主要预算) 和 native/include/coc/credit.hpp。磁盘或 I/O 失败时拒绝新副作用且不虚报落盘成功，不将失败写入报告为持久成功；数据回收遵循独立保留策略。

可靠状态使用独立命名空间，不导入不兼容的 outbox、业务回执或游标。配置、凭据、项目与权威历史保留并独立备份。持久状态不自动交给不兼容程序读取；升级 / 切换步骤见 [发行说明](RELEASE.md)。

创建会话在保存 session 的同一 SQLite 事务内，向原操作结果槽保存包含 sessionId 的恢复证据。初始化期间仍为 RESULT_PENDING，禁止提前确认；该期间崩溃后，原请求返回带 sessionId 的 RESULT_UNKNOWN，可核对原会话，不自动再次创建，也不表示初始化成功。已有真实终态仍返回原终态。

CW/CC 未闭合缺口的结果正文只进入持久 buffer；连续前缀推进时在同一提交中移入有界结果 cache，不重复持久保存正文。旧账本已有副本在缺口闭合时一并压缩，确认及 transfer 正文保留条件不变。

恢复拒绝错误由共享 deliveryRecoveryErrorSchema 定义；Worker 的 reset 分类和 CW HTTP 恢复停止条件复用该定义。传输未知、结果待定、背压与主机离线不属于 reset 分类。当前交换/连接校验仍先于冻结状态转换。

Agent 恢复响应复用 ACK 前经过水位校验的结果后缀页；ACK 只回收该水位及以前的前缀，响应窗口仍在 ACK 后读取。大结果描述符的 contentId/digest 复用一次固定正文摘要计算，wire 与保留语义不变。

原生恢复延迟共用 recovery.hpp，CW 与原生使用共享样例约束快速阈值及 30–60 秒慢速范围。重试计数在进入慢速阶段后饱和；持久请求和权限校验继续决定是否允许重试，计时器不成为持久状态。

控制确认由持久代际/主体/控制身份及 Agent 实例构造，不单独保存 ready JSON；命令请求键表不重复保存摘要，摘要表仍在正文回收后用于拒绝内容冲突。存储布局转换通过启动事务校验，不重放待办。

网页历史订阅与命令/HTTP/上传共用恢复延迟策略；原请求 canonical JSON 和配置原始字节仍使用各自固定的序列化语义，只共享 SHA-256 实现，不改变任何已保存摘要。

## 保留期限与连接授权

正文、请求和遗留积压默认最多一周，容量压力可提前回收，活动执行受保护。清理后的原请求由准入代次和单调屏障拒绝，返回 REQUEST_EXPIRED；历史订阅过期后重建，保留已提交内容。恢复凭证及不可恢复边界见 [数据保留](HISTORY_STORAGE.md)。

授权在准入和逻辑通道握手时检查，稳定数据帧不复查凭据或租约。授权变更以独立控制事件关闭连接，详见 [Worker 连接授权](WORKER_CONNECTION_AUTHORIZATION.md)。
