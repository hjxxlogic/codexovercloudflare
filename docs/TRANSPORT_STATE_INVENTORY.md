# 0.6.0 传输状态盘点与切换边界

2026-11-01。P0–P7 已按本机范围完成：唯一 delivery:2、全部预定业务写入口、Worker 去可靠业务状态、端点持久恢复、统一预算、真实旧更新器、最终回归与隔离切换材料。证据见 TEST_REPORT 的最终验收表；版本 0.6.0，未发布部署，未验证其它平台。后文明确标记的阶段记录描述当时范围，不作为当前待办。

## 云端字段去向

| 当前字段 / 路径 | 当前依赖 | 目标去向 / 切换规则 |
| --- | --- | --- |
| Host `send-head:*`、`head-instance:*` | `heads`、`advanceHead`、`advanceAgentHead`，命令、结果、RPC 输出及历史发送上界 | 已删除写入与读取；A/C 自身发布头及当前恢复快照提供上界，Worker 不验证 ACK 是否已落盘 |
| Host `receive-head:*`、`send-head:rpc-received:*` | 历史接收确认及 CC 输出确认 | 已删除云端读写；C 本地连续游标，A 的订阅 / 输出接收确认；不能以一个 C 的确认代表其它订阅者 |
| Host `send-head:result:*`、`send-head:result-received:*` | 结果发送 / 接收水位；目前基于命令序号 | 已迁移：A 完成日志独立 resultSeq；C 持久结果缓存及连续结果水位，ACK 向 A 转发；Worker 不再读写这两类头 |
| `operation:*`、`part:*`、`wire:*` 及对应 `due:*` | `start / command / complete / result` 的业务正文、异步结果与关联 | delivery 的 OPEN / 查询 / transfer 分块、历史直读 / 历史 socket 准入与订阅，以及 probe / 项目与会话列表 / 线程 / snapshot / 原请求结果 / 审批列表 / 文件读取与状态等只读控制查询已改为 128 条 / 8 MiB 的纯内存关联（pending 与完成结果各保留最多 20 秒），无 Operation / part / wire / 到期索引写入；全部业务入口现均使用同一有界内存关联；权限事务回执独立保留，不再复用这组业务键 |
| `agentInstance` | 将云端发送头绑定到 Agent 数据库 | 已删除云端 agentInstance 记录；存储实例由端点对账；Agent 认证与连接代际仍由 Worker 核验；不以缺失实例默认为 `legacy` 后接受业务 |
| `lease:*` 的 epoch、nextEpoch、owner、controllerId、previousControllerId、pending、active、expires | 接管、原控制端恢复、会话控制准入 | 保留为权限状态；区分 controlEpoch 与连接绑定；pending 不能因通知丢失回退到旧控制端 |
| `lease:*` / socket attachment 的 delivery.id、normal、priority | 已认证主体、会话、lane 到内部流的绑定 | 保留必要的授权路由绑定，移除发送头依赖；不能从客户端自报 owner 或 epoch 建立权限 |
| `agentEpoch`、ticket、handshake、授权缓存、session-mode | Agent fencing、一次性准入与读取模式检查 | 保留权限核验及失效边界；不得把移除可靠进度扩大为删除这些状态 |
| Registry 的授权、撤销、目录及管理元数据 | 凭据权限、主机可见性、控制入口 | 保留；缓存失效、断连及 HTTP 入口必须一致执行 |
| `host-lifecycle.ts` DO / D1 复制、`host-state.ts` 的 `d1PermissionReceipt` | 权限事务归档 / 离线读取 | 已过滤旧 operation / part / wire 及对应 due，旧业务回执不能恢复；仅 permission-operation / permission-wire 的 ticket / 接管事务继续持久化 |
| `management.ts` 的 ManagementRequests | 管理通道临时 wire 关联 | 继续有界临时转发；配置执行回执在执行端，不混入业务 ACK |

## 业务入口责任

| 入口 | 执行端机制 | 当前验证 / 边界 |
| --- | --- | --- |
| 会话创建 | transport2_operations 绑定主体 / 原 requestId / Agent 实例，返回原 sessionId | 已强制首发持久意图，删除 create.key 及旧 requests 副本；已验证丢回复、重启重查和实例冲突，安装后完整 E2E 已通过 |
| 停止会话 | Agent 会话状态与 transport2_operations 原结果 | 已强制原请求证明、持久终态和原意图恢复；不从传输超时推断已停止 |
| 项目修改 | Agent 项目注册表与管理授权 | 为修改保存原请求及固定内容、结果；重试不能变成新的修改；查询保留原授权检查 |
| 文件上传 | Agent uploadId、版本、偏移、分块重复校验和完成 cache；临时文件 fsync | C 首发身份落盘，故障后查原 uploadId；已发布但回执不明返回未知，不覆盖新版本；Windows 不在本轮范围 |
| 会话任务 / 写 RPC | A 命令日志、CW/CC 持久 outbox，received / started / finished | 独立结果、控制代际、精确取消、命令 / 结果预留及有界流退役已接入；完整授权及唯一新版协议已通过 |
| 审批 / 中断 | 独立 priority lane 与业务允许列表 | 已绑定审批 runtime / ID / 版本、取消原主体 / 代际 / 流 / 请求 / turnId，先到取消标记已持久化；本地取消身份已有独立于诊断尾部的 1024 项持久拒绝账本；资源与协议验收已通过 |
| 历史 / 大正文 | A SQLite 的 revision / content 与 C 历史缓存 | 已实现 A 订阅确认及尾部重试；transfer 全文落盘前不确认；权威历史预算已加入；history 不可变引用已验证：ACK 不删除历史，原修订变化或清理后 CONTENT_UNAVAILABLE |
| CC RPC 输出 | A 输出日志及 C 输出进度 cache | 已接入持久接收、按消费推进信用、输出全局 / 单流预算及尾部重试；Worker rpc 发送头已删除；唯一新版线协议已强制 |
| 远程配置 / 重启 | 执行端 RemoteConfiguration 原 requestId 与版本校验；管理通道临时关联 | 保持独立管理员权限；执行回执及重启前提交边界另验，不并入会话信用 |
| 更新器 | 旧 manifest、来源、SHA256、候选身份校验、安装锁和替换 | 真实旧二进制手动 update 的 14 项与安装后 42 项 E2E 已通过；release protocol 保持 1，业务 delivery 独立升为 2；不把测试替身等同真实旧发行二进制 |

## 历史实施阶段记录

以下至“当前统一资源盘点与本机测量”前为各阶段快照；其中待办随后已完成，当前结果以本文顶部和最终验收报告为准。

### 基础边界

CW 与 CC 的本地排队项使用 seq=0 / end=0 表示尚未发布；该值不会发到网络。取得接收信用后，序号、UTF-8 累计字节位置及 outbox 在同一提交中固定，再允许发送。写入失败回滚本地分配，原排队项保留；已发布项重试继续使用原身份。

OPEN 具有唯一 exchangeId，HTTP / WebSocket 读取将该值转给 Agent 并回显。双方 lane 快照齐备前暂停发布，退休连接、过期交换和恢复完成前无交换身份的在线响应不能建立窗口。权威回退仅与该交换开始时保存的确认水位比较；快照重复响应及在线旧 ACK 不能覆盖更高水位。相同 ACK 序号必须具有相同字节位置，向前推进必须匹配实际已发布项边界。

有待办时，CW 与 CC 在有限快速重试后持续以 30–60 秒抖动恢复；提交进度使快速重试预算复位。待办清空且窗口已建立时不再调度恢复。暂停 / 退出 / 存储冲突仍停止自动发送。Worker 已删除传输头读写，租约核验独立保留；Operation 业务回执迁移仍未完成。

独立结果完成日志已接入 A / CW / CC：完成事务分配 resultSeq，结果 ACK 只清理该完成前缀，保留序号 / 摘要身份；结果逆序完成与乱序到达均有测试。大结果的 transfer 描述符包含不可变长度 / revision / SHA-256；16 KiB UTF-8 边界分块在客户端取齐、校验、保存全文后才确认，Agent 确认后才回收内容。当前单个 transfer 上限 2 MiB，单端结果缓冲 100 条 / 2 MiB，结果缓存尾部 64 条 / 2 MiB；这些仍非全局预算。Worker 不再写结果进度；OPEN、结果查询与分块读取仅用有界内存关联，重建丢失时返回 RESULT_UNKNOWN，由 C 重查原端点身份。Agent 自报的历史 / 输出头随结果透传，Worker 不合并或登记这些结果帧的头。Worker 全部发送头已移除，其它业务 Operation 仍须迁出。

CC 输出先提交完整正文、连续序号和字节位置，再发送接收确认及交给 TUI。未交付正文不得淘汰，消费后仅保留有界诊断尾部；清理普通历史缓存保留这些记录。Agent 在既有 30 秒维护调度中仅为未确认结果 / RPC 输出补发，静默丢 ACK 测试覆盖无新业务的恢复。新 SQLite 表使用 transport2_*、CW 使用 delivery-outbox-v2、CC 使用 :delivery:v2 / :output:v2，不读取旧传输待办。

网页创建 / 停止会话和项目修改已接入同样的原请求账本。首次意图先以 IndexedDB 原子 read-modify-write 占用既有 32 MiB 预留，再查询并持久绑定 Agent 实例；Web Locks 在同一主体 / 主机范围串行网络交换，并以四个全站槽限制在途交换，BroadcastChannel 唤醒其它标签页。最多 32 项未确认 / 1024 项身份，终态提交后才确认，确认后回收输入并保留 16 项 / 4 MiB 结果尾部及永久拒绝摘要；无待办停止恢复。管理员项目管理使用实际 owner 哈希及同一主机范围，云端 identity / probe 仍验证 owner 和主机有效性。上传及其余写入口、旧业务路径去除仍待完成。

上传执行端已将回执从普通 cache 移入 transport2_uploads；开始创建暂存文件前持久绑定主体 / 项目根 / uploadId 与原路径、大小、覆盖意图摘要，并预留完整暂存大小和 16 KiB 元数据。全局最多 4 个未解除资源承诺 / 80 MiB 暂存，每主体最多 2 个；拒绝身份全局 1024 / 每主体 256，总预算 96 MiB。分块推进连续偏移前同步文件；完成和取消先回收暂存资源再释放对应预留，永久保留旧身份，清普通缓存和旧一天期限不重新放行。重启中的上传固定为 unknown；无法证明资源已回收时保守保留预留，不能通过重启扩大磁盘承诺。网页完整正文首发持久化、上传恢复及云端写路径收敛仍待完成，本段仅描述执行端基础。

## 控制代际实施进展

Worker 在权限事务中分配 controlEpoch 和独立的连接 generation，分配 pending 时立即关闭旧写入资格；失败 / 过期保持隔离，不回退 active。CW 在首次 attach 前持久保存 claimId；同一 claim 重试沿用原控制代际，授权恢复原流时只增加连接 generation。OPEN 由 Worker 绑定主体和控制证明，A 在 transport2_control / transport2_flow_control 中持久提交代际，事务终结旧代际 received 项为 STALE_CONTROLLER，已 started 项继续记录实际结果。旧流拒绝重绑定和迟到写入。

Worker 只接受仍匹配当前权限记录、Agent 连接及实例的 CONTROL_READY；CW / CC 在两 lane 的当前 exchange 确认后才发布业务。CW 将旧控制流待办保留在有界 retired 集合中，新流不继承其序号或信用；CC 拒绝将旧流直接绑定新控制身份。retired 待办的交互式对账及整个唯一 delivery:2 切换仍需完成，不能把保留记录解释为已经取消旧副作用。

## 精确取消实施进展

A 增加 transport2_flow_owner、transport2_command_keys 和 transport2_cancel，取消验证原存储实例 / 主体 / controlEpoch / 流 / 原请求；web:<requestId>、rpc:<JSON id> 与 reply:<JSON id> 分开记录。未知目标的取消先持久保留；迟到原命令依旧推进连续接收位置，同事务生成 CANCELLED_BEFORE_START 结果，禁止派发。已开始命令只返回 started，不能由取消回执声称停止。标记每流 4 条、全局 128 条 / 64 KiB（含开销），满时明确背压；退役控制流先隔离，再释放不再可能到达的标记。

网页使用 Agent 发布的 activeTask / turnId 发停止命令。Web interrupt.target 现在是唯一必填格式；CW 入队、Worker 转发、A 记录接收之前均校验，已移除无目标中断与任意下一 turn 的延迟中断回退。CW / CC sender 的未发布取消与序号发布串行提交，已发布项不删除；诊断尾部 64 条 / 512 KiB。原生 CLI 已保存并附加中断目标，传输元数据在转交 TUI 前移除。TUI $/cancelRequest 已接入本地原子取消；已发布目标以 priority coc/cancel 提交，先到的标记阻止迟到启动。取消接收回执不伪造 turn/completed。审批现在绑定 runtime / version；CW 使用原事件证明，CLI 在输出确认前保存原证明、答复时附加，显式 HTTP / CLI 命令要求提供原证明。重复使用的 server request ID 以版本区分。R4 全局资源预留仍未完成，本段不表示完整架构已验收。


项目执行端资源已加入独立固定预算：整个 Agent 的项目目录、按主体 / requestId 绑定的永久身份、短结果尾部、已移除项目 ID、原子替换副本和结果预留共用 16 MiB。永久身份 / 已移除 ID 各最多 1024，结果最多 16 项 / 4 MiB；保守计量同时预留原文件与一次原子替换，Linux 在下一次写入前清理并同步旧的未发布临时文件。目录创建前检查包含 available 字段的目录响应上限，先持久保存 started 与结果空间。结果尾部淘汰后返回 RESULT_UNAVAILABLE，原编号仍拒绝重开；执行中退出变为 RESULT_UNKNOWN。旧项目配置保留，旧业务 receipts 不导入新版 journal。其它运行时和管理资源仍需完整审计，不据此完成 R4。

## 资源与切换待办

现有单流预算 normal 16 条 / 2 MiB、priority 4 条 / 512 KiB，发送缓冲 normal 96 条 / 1.5 MiB、priority 4 条 / 512 KiB，单帧 256 KiB。它们仍不是全局承诺预算，不能据此勾选 P0 / P2 完成。需在实现配置中确定并测试全局、会话、流、结果、取消标记及控制保留预算，事务预留的总占用必须满足设计 5.1 节公式。

切换须独立备份授权、凭据、配置、项目和历史，等待旧任务结束、核对未知结果，再建立新传输命名空间。旧 outbox / 游标不导入新流；旧业务传输字段只在明确切换脚本中清理，不删除整库。完成唯一 delivery:2、全部业务入口和旧更新器验证后才统一标记 0.6.0。本轮按用户要求只本地构建和测试，不触发 GitHub Actions，也不发布或部署。


## R4 Agent 命令 / 结果预算阶段（2026-11-01）

已实现持久预留账本 transport2_credit / transport2_namespaces；预算及单流记录上限见 native/include/coc/credit.hpp。OPEN、发放信用和分配 serial / generation 同事务；重复 OPEN 不重复预留。normal / priority 分开计量，全局与单会话同时限制。未确认终态继续占槽，确认后清理命令 / 结果正文，摘要及原请求索引仍参与重复验证；可靠网页命令不另写无界 requests 回执副本。

关闭先建立持久拒绝边界，再处理 received 终态和释放。未确认结果、started 命令及实际运行任务仍占预留，重启恢复原承诺。最多 1024 条命令 / 流、1024 个分配及关闭记录；不能压缩时拒绝新分配，旧 ID 不重新开放。客户端重连校验保存的 serial / generation。

本阶段没有完成 R4 整体：客户端跨标签页 / 跨会话资源、输出与历史日志预算、全局控制队列、所有正文 / 索引的统一计量及唯一新版线协议绑定仍需落地。不得将命令账本覆盖范围误写为全应用物理磁盘配额。


## R4 客户端预留与输出阶段（2026-11-01）

已增加 CC 持久本地预留、CW 跨标签页 IndexedDB 事务账本和普通缓存计量，参数见 ARCHITECTURE 的客户端全局计量段及 cache-budget.ts / credit.hpp。已确认的输出先落盘，信用只随连续 TUI 消费前进；未消费正文不被诊断尾部清理挤掉。Agent 输出按全局 / 单流容量及记录数计量，ACK 事务回收，慢客户端耗尽时停止其 runtime 并记录原因。

会话 runtime 退出会退役命令流；closed / exhausted 的客户端仍恢复已接收请求的原结果，不能冻结结果查询。普通历史清理不释放命令预留；当前关闭记录无法证明可压缩时采取有界停止分配。

剩余 R4 项：A 权威历史及订阅信用、其它业务及管理队列的统一计量、可靠流退休的完整授权生命周期、取消身份尾部的永久拒绝边界，以及 receiver serial / generation 的唯一新版线协议强制绑定。不能把这些局部账本标记为 R4 或 P2 全部完成。

原生普通缓存已补充跨身份的共享事务账本及按凭据前缀隔离；同一 cache-dir 使用 transport-v3 公共数据库，不再按每个凭据分库乘出预算。仍需完成 A 权威历史和其它业务持久记录的统一预算，不能据此勾选完整 R4。


## 历史订阅阶段（2026-11-01）

已实现 transport2_history_subscriptions：端点持久 ACK、分配代际、Agent / C 实例与恢复 exchange 校验，1024 项上限及退休永久拒绝；128 在线路由、合并 dirty 提示与持续慢速恢复。CW 的实际缓存提交驱动确认；实时链丢尾部由 Agent 未确认水位发现，不依赖 Worker 新业务进度。关闭页面 / 路由暂停重试，新的恢复沿用原订阅；显式清理缓存使用新身份。

Worker 已停止历史 send-head / receive-head / head-instance 的读取与写入，删除 /progress；历史直读、history-open、订阅 ACK 为纯内存转发。后续 P3 已移除命令 / RPC 等全部 Worker heads 读写，控制端和 Agent fencing 独立校验；旧进度字段不再归档或恢复。后续 P4 已迁移综合 snapshot 等只读查询；写操作的业务 Operation 及其归档字段仍待收敛。A 权威历史 / 正文总预算、其它业务与控制元数据预算，仍需完成；CC 附着观察器已接入相同的持久确认与恢复检查，取消空闲周期读页，单次 history 命令仍为有限只读。

## P3 Worker 传输进度去除（2026-11-01）

heads / advanceHead / advanceAgentHead 已删除；controllerHeads 拆为纯权限 assertController。HTTP 与 WebSocket 保留控制租约、主体及 Agent 连接代际核验；输出 ACK 只校验结构和转发，实际发布上界由 A 校验。Worker 不合并端点 heads，HostLifecycle 归档与恢复过滤旧进度键及 agentInstance，保留租约 / epoch / 目录。旧线上数据未修改，P4 的业务 Operation 迁移仍待完成。

## P4 只读入口与本地取消拒绝边界（2026-11-01）

纯读取不再生成 Operation / part / wire / due 持久记录，关联丢失由 C 重新读取 A。CW 的 GET 与明确只读 POST 最多尝试三次；CC 的 GET 遇 RESULT_UNKNOWN 最多尝试三次，保留同一请求编号；撤销与权限拒绝停止，写操作不进入此重读策略。项目管理的 list / browse 仍在发送及返回前核验管理授权；审批列表仍先核验会话模式。旧云端写业务回执仍未迁完，P4 不勾选。

CW / CC 本地取消保存独立的 SHA-256 原请求拒绝集合，每份 outbox 最多 1024 项，在该 outbox 生命周期内不因诊断尾部清理而删除。取消正文仍仅留 64 项 / 512 KiB；永久集合满时拒绝新取消并保留原排队项，不假报成功。集合计入既有 outbox 预留；缓存清理不删除可靠 outbox。审批自动尝试状态改为只随当前 Approval 对象保留，已解决审批不再留在不断增长的 runtime 集合。

## A 权威历史 / 正文预算（2026-11-01）

新增 transport2_history_entries / history_budget：events、history、chunks、bodies、streams、external_items 的行及索引 / 账本开销分别计量，同一 SQLite 事务更新正文、投影及全局 / 会话账本。上限全局 256 MiB / 250000 条、单会话 64 MiB / 64000 条、1024 个非空历史作用域；具体参数见 credit.hpp。替换释放旧正文的实际计量，重复外部轮询不增加占用；普通清理不删除权威正文。

容量不足返回 BACKPRESSURE 并触发 Agent 既有停止副作用的存储故障回调；没有落盘的事件不发布 revision，不返回伪造确认。命令终态使用独立预留，历史耗尽不挤占结果容量。既有历史首次建立账本时完整计入，已超限内容仍可读，后续增长被拒绝；不迁移或删除生产数据。独立 archive_event 现也包在事务内，正文或投影失败一并回滚。现有周期指标加入 historyBytes / historyRecords，无新增云端业务轮询。

这是权威历史存储的逻辑计量，并非 SQLite 文件、空闲页和 WAL 的物理磁盘配额；真实 I/O / 磁盘故障继续停止确认。其它写业务、管理 / 控制元数据的统一预算及唯一新版线协议仍待完成，P0 / P2 / P4 不因此全部勾选。

## P4 执行端原请求回执基础（2026-11-01）

A 的 transport2_operations 按可信主体 / 原 requestId 建立唯一键，并绑定持久 Agent instance 及 action / data 摘要。开始执行前提交 started；重复 started 返回 RESULT_PENDING，completed 返回原数据或错误，Agent 进程重启将 started 固定为 RESULT_UNKNOWN，不再次派发。完成回执先提交再回复，带原身份的结果确认匹配原 action / data 后才清正文；acked 身份永久拒绝重开。

每项执行前预留 256 KiB 正文加 8192 字节记录开销，全局 128 MiB / 主体 32 MiB，全部存活及退休身份合计最多 1024 项。终态未确认仍占原预留；确认后保留 8192 字节身份 / 摘要。退休边界不能压缩时停止分配，不通过 TTL 重新放行旧请求；当前是独立的有界业务账本，尚未代表管理 / 控制资源全部统一计量。

Worker 根据 x-coc-operation-instance、Idempotency-Key 和可选 x-coc-operation-ack: 1 构造 intent，owner 覆盖为当前鉴权主体。携带 intent 的关联共用 128 条 / 8 MiB 内存转发，重建后只能重查原请求；执行阶段只接受匹配 intent 的成功回执，停止及确认仍先读取会话模式并验证权限。A probe 返回 deliveryInstance，实例改变拒绝原操作，不能把原意图重绑新库。

CC 的 connect / observe、stop、queue、approve / reject 和项目修改已接入完整原请求意图与终态提交 / 确认，恢复重查原身份；CW 及其它业务尚未全部接入，旧客户端路径及云端写业务回执仍在，因此 P4 未完成，也未启用唯一 delivery:2。

CC 的 transport2_local_operations 与普通缓存分表，按凭据前缀隔离并使用既有共享全局命令额度中的 32 MiB 预留。最多 32 项未确认 / 1024 项身份，确认后清原正文并保留 16 项 / 4 MiB 终态尾部；结果尾部淘汰不重开身份。prepare / finish / confirm 各自为 SQLite IMMEDIATE 事务，多进程不会覆盖原意图；用量指标包含该分表正文和元数据。cache-clear 保留待办及拒绝边界。命令运行时有限快速重试后转 30–60 秒慢速原结果 / 确认恢复，退出进程暂停；request 原编号按已存正文和实例继续，实例替换不重绑，已持久 RESULT_UNKNOWN 只确认结果，不再执行。


## CW 上传原意图与恢复（2026-11-01，本机验收）

网页上传已接入独立持久账本 delivery-outbox-upload:v2，完整文件、原编号、目标 / 覆盖选择及 SHA-256 在首次网络发送前原子保存，占用既有全局命令额度中的 32 MiB 预留；单文件 20 MiB、每个主机作用域一个未解决文件、128 项永久拒绝身份。begin / finish 使用原请求账本并提交终态后确认；分块 / 状态查询沿用原上传编号和 Agent 实例，先读连续偏移，再串行发送 64 KiB 原块，丢包按原块重传。Agent 校验完整 SHA-256 后才发布；C 保存匹配大小 / 校验和的终态后释放文件正文。已确认 HTTP 结果正文从有限尾部回收时，保留身份与实例仍可查原上传回执，不再次创建或发布。

关闭面板或显式暂停保留完整正文，重新打开自动沿原意图恢复；实例变化、原暂存未知或本地正文冲突冻结，不能以新编号重试未知副作用。普通缓存清理保留可靠账本。Worker 所有文件操作使用有界内存关联，不保存上传正文或结果。已通过上传单元故障测试、真实 IndexedDB 20 MiB 落盘 / 页面重开 / 清缓存保留，以及实际 Agent + Wrangler + Chromium 的首块已落盘后回包丢失、暂停关闭面板再打开恢复与逐字节校验。其它旧写路径清理、唯一 delivery:2 及完整资源验收仍待完成，P4 尚未全部完成；Windows 构建按用户要求不在本轮验收范围。


## delivery:2 准入与历史清理隔离（2026-11-01，本机阶段）

Agent 能力协商、CW 控制连接、CC ticket / attached / delivery-ready 及主机业务 HTTP 入口均要求 delivery:2；HTTP 使用 X-CoC-Delivery: 2，浏览器 WebSocket 使用 delivery=2。缺失、旧版及未知版本在处理业务前拒绝；客户端也核验中继响应版本。发行 manifest / 原生 build 的 protocol 仍为 1，保留旧更新器通路，不代表兼容旧业务协议。

CW 已移除裸 WebSocket 写入和旧 requests 查询回退，CC 附着要求持久账本及新版 ticket；CLI request 只恢复本地保存的完整原意图，本地找不到时返回 NOT_FOUND。服务端旧业务处理分支、云端旧 Operation 存储及接收端信用代际的强制帧绑定尚未全部删除，因此 P1 / P4 仍未完成，版本未升为 0.6.0。

历史订阅在每次发送 OPEN / ACK 前核验原持久记录；保存窗口使用原记录比较与替换事务。另一进程 / 标签页清空或更改记录时，旧订阅停止，迟到窗口不能重建旧身份，也不能继续以旧内存游标确认。CC 的耐久游标从实际缓存读取，不以进程内副本代替；清理后新的订阅使用新身份。

远程配置 / 重启的执行回执最多保留 256 项永久身份，每项上限 8192 字节；新身份在文件变更或重启前预留，容量满时返回 BACKPRESSURE，原身份仍可重查。该边界不以 TTL 或清理诊断尾部重新开放旧请求；全应用控制资源的统一验收仍待完成。


## 接收端信用分配的强制绑定（2026-11-01，本机实施）

WINDOW 必须包含 Agent instance、streamSerial 和 creditGeneration；CW / CC 在建立窗口及发布序号前验证并持久保存三者。delivery-command、delivery-query、delivery-content 和 delivery-receipt 均必须携带相同分配证明，Worker 只做结构和权限检查后原样转发，由 A 在接收命令、读取结果 / 正文或推进结果 ACK 前核验原分配。错误、缺失或跨流证明不消费原命令序号，也不为未知流分配信用。

首次 OPEN 允许尚无分配证明，但只能确认结果位置 0 / 字节 0，不能夹带结果 / 正文查询；接收后沿原分配恢复。已知窗口的 OPEN 按 lane 附带 allocations，HTTP 恢复读携带相同三元组。transfer 分块响应也须与原窗口的全部分配字段一致。此改动不允许回退旧业务帧；其它旧业务路径和云端 Operation 清理仍待完成，P1 / P4 尚未整体验收。


## Worker 业务 Operation 去状态（2026-11-01，本机阶段）

所有非 ticket / attach 请求共用 128 条 / 8 MiB 的内存关联，pending / completed 最多各保留 20 秒。创建、停止、排队、审批、项目修改与读查询均不再写 operation / part / wire 或到期索引；Worker 重建后原临时编号返回 RESULT_UNKNOWN，由端点原请求账本恢复。未删除 Agent 的旧业务分支，此阶段不代表 P1 / P4 全部完成。

权限握手使用 permission_ 编号和独立 permission-operation / permission-wire 命名空间；最多 64 条 pending、256 条总记录，每条 JSON UTF-8 不超过 16 KiB。输入仅保留 sessionId、takeover、claimId、resume、delivery，get 返回仅保存 mode / sandbox，不复制标题、历史或完整会话。权限结果、wire 替换及到期索引同事务保存，重建恢复到期调度，不再拆分正文。D1 只离线读取 / 确认这类权限回执，所有业务查询回到活跃 Host 的有界内存。旧 operation / part / wire 和相应 due 无法再被归档或恢复，租约 / epoch / ticket 保留；未修改线上数据库。


## 控制类写入口的唯一原请求路径（2026-11-01，仅本机）

Worker 和 Agent 对 create / stop / queue / answer、项目修改以及上传 begin / finish 强制要求原请求 intent，缺失证明在执行副作用前返回 UPGRADE_REQUIRED。读取、ticket / attach、可靠会话 OPEN 和按原上传编号 / 偏移校验的 chunk / cancel 不进入此 HTTP 原请求账本；读取携带写证明仍拒绝。两端使用同一组 23 项分类样例，Worker 保留会话模式与项目管理授权检查。

会话创建 / 外部观察不再写 create:<key> 的旧 requests / request_states 副本，成功或失败只由 transport2_operations 返回原结果；create 控制帧移除旧 key 字段。删除 GET /hosts/:id/requests/:id、control request 及相应生成协议，CLI request 只使用此前保存的完整本地原意图。外部队列和审批的 HTTP 路径已通过持久操作账本，不再进入旧网页回执或外部 submission 普通缓存；不确定的队列回复重复查询仍返回原 RESULT_UNKNOWN，不生成新提交。裸会话写入、旧 Store API / 表创建及可选持久化 TUI 分支已在下阶段移除；完整 P1 / P4 仍需唯一上传格式和资源验收。


## 会话写入唯一命令窗口（2026-11-01，本机阶段）

Worker 和 Agent 均拒绝没有持久命令窗口的会话写入（UPGRADE_REQUIRED），包括网页任务、审批 / 策略 / 中断及 CLI 初始化、线程 / 任务修改和审批答复；只读 sync / models 与 RPC 读取允许列表继续直接转发。Agent 只由带原控制证明的 OPEN 生效控制权，不再由普通帧激活待定 epoch，接收命令前核验原流所属会话。CLI 输出始终写入有界持久日志，TUI 桥必须提供持久 Store，删除无账本直发分支。

网页及外部队列 / 审批已移除旧 begin / submitted / finish 回执和 external-submission 普通缓存路径；删除旧 Store API，新库不再创建 requests / request_states 表，重复与未知结果只由原命令或 transport2_operations 账本决定。此次不删除现有机器的数据文件，发行切换的备份 / 清理仍待实施。


## 上传原始摘要与实例的强制格式（2026-11-01，本机阶段）

上传 begin 必须携带完整文件 SHA-256，并随原路径、大小、覆盖选择一起纳入持久意图摘要；begin 的 Agent 实例由必需的 HTTP 原请求证明固定。chunk / status / cancel / finish 均必须携带原 agentInstance，finish 还须携带与 begin 相同的 SHA-256。Agent 在处理前拒绝缺失或错误实例及格式不合法的摘要；发布前重新读取暂存全文校验，原摘要、finish 摘要或实际字节不一致时均不发布。相同上传身份更改内容意图返回冲突，已完成或退役身份不能重新创建暂存文件。WorkspaceFiles 必须使用持久 Store，删除内存回执实现；不导入旧的缺摘要 / 无实例业务格式。

本机验证涵盖 C++ / Zod 共享缺字段与错误格式、实例替换、重复 begin 内容冲突、暂存字节不符以及持久回执与资源承诺；仍需完成统一资源预算、真实旧程序升级与最终切换，不能据此声明 0.6.0 整体验收完成。


## Codex 进程与 RPC 资源收口（2026-11-01）

会话进程最多 16 个，临时历史读取另留 4 个，构造前预留，关闭中的对象及异步 I/O 未释放前仍计数。普通未完成 RPC / 输入队列分别限制每进程及 Agent 全局条数与计量字节，中断和审批回复使用独立预留；具体参数见 credit.hpp 和传输架构第 5.1 节。CLI 统一分配内部 ID，原客户端字符串 / 数字 ID 仅用于恢复答复；超时 / 退出保留未知语义，迟到内部回复不会转交另一请求。新任务先取得两项预留，随后才保存运行状态与用户事件。已通过实际子进程压力、真实 Agent 的满载中断 / 新任务拒绝，以及 16 个会话占满后的临时历史查询。审批集合、Web 排队、其它管理资源、物理占用测量及完整 R4 仍待完成。


## Web 队列与审批集合预算（2026-11-01）

Agent 的 Web 待执行队列（含正在处理的项）每会话最多 100 条 / 2 MiB、全局 512 条 / 16 MiB；priority 独立每会话 8 条 / 512 KiB、全局 64 条 / 2 MiB。实际保留的帧与闭包按编码八倍加 16 KiB 计量；取消未开始的原任务立即归还其队列额度。待决审批每会话最多 32 条 / 1 MiB、全局 128 条 / 8 MiB，另限制全部审批的保守线编码为每会话 64 KiB / 全局 1 MiB，保证与历史快照一起可在单帧内返回；条数、内存和线编码任一先满均拒绝。共享审批的原件与镜像持有同一额度，直到最后一份实际引用释放。外部审批连接的内部请求另限每连接 4 条 / 64 KiB、全局 64 条 / 1 MiB。完全相同的待决审批重发沿用原版本；未解决 ID 被用于不同内容时断开对应运行时。普通进程审批超额明确拒绝；外部审批超额断开转发并保留原服务器待决状态，不自动答复。结果路由仅保留执行中或未确认的流，确认及关闭后回收；查询已退休路由不创建持久元数据。probe / metrics 仅报告这些集合的条数与计量字节，不含正文。

实际 Agent / stdio / 共享 app-server 压测通过全局 512 条普通队列、128 条审批、独立 priority、字节拒绝、精确取消即时归还、重复审批版本、冲突断开和外部审批原待决保留。仍待其它管理资源审计、物理占用测量、真实旧更新器及最终切换；不据此标记 R4 完成。


## 私有原子替换的遗留回收（2026-11-01）

Linux 私有配置、凭据及更新状态的原子替换在父目录锁内清理同一目标的精确 `.tmp-UUID` 遗留，再写入新暂存文件；清理与发布均同步父目录。锁随进程退出由内核释放，活跃写入期间其它私有写入返回 CONFIG_BUSY，不删除对方文件；不增加回执目录中的锁文件，不跟随遗留符号链接，也不清理其它命名文件。重复崩溃不会为同一目标无限累积暂存正文。


## 当前统一资源盘点与本机测量

| 资源 | 固定边界与释放规则 | 源码 / 证据 |
| --- | --- | --- |
| A 命令 / 结果 / 流 | 持久 normal 512 MiB、priority 256 MiB；1024 流 / 每流 1024 身份，先预留结果；ACK / 退役再归还 | credit.hpp、credit.cpp、native-core |
| C 命令 / 输出 / 普通缓存 | 命令每份 32 MiB / 全局 512 MiB，CC 输出每份 8 MiB / 全局 128 MiB；普通缓存 64 MiB / 单范围 16 MiB | CC SQLite 与 CW IndexedDB 事务并发测试 |
| A 历史 / 输出 | 历史 256 MiB / 单会话 64 MiB，输出 64 MiB / 单会话 8 MiB；保留未确认正文，拒绝增长 | native-history-budget、native-delivery |
| A HTTP 原请求 / 上传 | 原请求 128 MiB / 主体 32 MiB / 1024 身份；上传 96 MiB / 4 个 active / 主体 2 个 / 单文件 20 MiB | native-operations、native-uploads、完整 E2E |
| A 项目 / 配置 | 项目含替换副本 16 MiB / 1024 永久身份；配置每实例 256 身份 / 每项 8192 字节，原文 64 KiB | native-projects、native-configuration、SIGKILL 暂存回收 |
| A 进程 / RPC / Web / 审批 | 16 会话 + 4 历史进程；普通 / priority 独立条数与字节预留；审批单会话 32 / 全局 128 与独立线编码上限 | runtime-budget、runtime-scopes、probe 元数据 |
| W 业务 / 权限 / 管理 | 业务 128 条 / 8 MiB / 20 秒临时关联；权限 64 pending / 256 总数 / 每项 16 KiB；管理 128 条 / 8 MiB | relay-order、host-lifecycle |
| W 收发与鉴权集合 | 收入每连接 1024 / 全局 2048 条、每连接 8 MiB / 全局 16 MiB；转发每连接 1000 / 全局 2000 条及相同字节边界；在途鉴权 128 | 零字节帧、跨连接转发、鉴权并发专项 |

`/tmp/coc-runtime-resource-samples.log` 的真实 Agent 样本：512 条 Web 队列时 RSS 17,817,600 字节、状态文件 1,442,507 字节；Web 字节压力时 RSS 19,275,776 字节、状态文件 2,851,547 字节；128 项待决审批时峰值 RSS 19,832,832 字节、状态文件 4,964,499 字节。这是当前确定性夹具的观测，未包含子进程 RSS，不作为整机内存上限、磁盘硬配额或生产容量承诺。逻辑字节包含独立计量开销，不能与 RSS 直接比较或推出费用节省比例。正常空闲无鉴权轮询 / 周期 alarm 已有测试，持续 1000 帧结果 / 窗口负载加消费确认的 Host 存储写入为零；权限状态仍可写入。

## 简化后的持久布局（2026-11-01）

transport2_control 保留 session/epoch/control_id/owner，ready 由这些权威列及固定 Agent 实例派生；transport2_command_keys 保留 stream/request_id/seq，摘要唯一存于 transport2_command_digests。同流旧主体快照、连续水位、信用承诺、关闭及去重拒绝身份不变。旧 delivery:2 布局在启动事务内校验一致后转换，冲突拒绝且回滚；不支持转换后直接降级旧程序。已删除不再需要的启动正文回填循环。详见简化审计第六批。

transport2_namespaces 只保留 scope/allocated；closedThrough 诊断值从同一查询快照的未关闭 credit 最小 serial−1 推导，无未关闭流则为 allocated。credit 拒绝墓碑不清除，分配及关闭仍事务提交。旧关闭游标不一致拒绝转换并回滚全部表转换；详见简化审计第八批。
