# Worker 授权与建连后转发审计

[文档索引](README.md)

日期：2026-11-03。审计基线：`069be79a5030a8c6eb501cbf42e7e8d0fdb99e28`。
状态：原始审计及计划保留；已按计划实施本机改造，尚未部署。改造后的契约见 [Worker 连接授权契约](WORKER_CONNECTION_AUTHORIZATION.md)，验证记录见 TEST_REPORT。当前工作区仅保留原生 DO，旧后端清理见 [记录](DO_ONLY_STORAGE_2026-11-03.md)。下列现状证据描述审计基线，不代表改造后的工作区。

## 1. 目标与结论

目标：Worker 在权限职责上仅负责授权；连接只在建立时检查授权，建立后的数据包不再检查授权。云端仍提供必要的连接路由和有界转发；业务执行、业务校验、审批、沙箱、RPC 允许列表及可靠交付由 Agent / Client 负责。

**当前实现不符合这个目标。** HTTP 入口已进行凭据检查，HostRelayDO 随后仍在入站帧、出站转发、异步结果、Terminal 双向数据及通知投递中重新检查授权。5 秒授权缓存只降低后端查询频率，没有消除逐包鉴权。Worker 也解析业务正文、分类读写与 lane，并按包查询控制权状态。

本文中的 Worker 包括 `index.ts` 入口、HostRelayDO 和 RegistryDO。仅修改入口不会消除 DO 中的检查。“数据包”指应用 WebSocket 帧及业务响应，不是 TCP/IP 包。

目标不意味着允许客户端自报任意身份或路由：身份、主机、会话、通道权限必须在建连时绑定；已建立连接只能使用该绑定。帧大小、背压、连接是否关闭和固定路由匹配属于传输约束，不能借此恢复逐包凭据、权限表或租约查询。

## 2. 审计方法与边界

- 静态追踪 `apps/relay/src/index.ts`、`host.ts`、`registry.ts`、`common.ts`、`project-auth.ts`，核对授权调用、握手、消息回调、结果回调及撤销入口。
- 对照 `docs/TRANSPORT_ARCHITECTURE.md`、`RELIABLE_TRANSPORT.md` 和现有回归测试；检查 Agent 已有控制代际与本机策略实现。
- 执行 `npx vitest run tests/relay-order.test.ts tests/device-auth.test.ts`：2 个文件、143 项测试全部通过。这证明当前测试基线通过，不代表目标行为已实现。
- 未运行线上流量采样、完整 E2E、全部 CTest、CI 或部署；没有延迟、D1 费用或性能收益的实测结论。源码行为不能直接推断线上正在运行的版本。

下列行号均针对审计基线，修改后请按函数名定位。

## 3. 现状证据

| 路径 / 职责                  | 源码位置                                                                              | 当前行为及与目标的差距                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 外部入口                     | `apps/relay/src/index.ts:70`、`:95`、`:153`                                           | `authenticate` / `authenticateAgent` 验证凭据、角色与 host；入口还执行 Access、Origin 和浏览器身份绑定。这些属于应保留的准入检查。         |
| 内部身份传递                 | `apps/relay/src/index.ts:113`                                                         | `internal` 新建内部请求并生成 `x-auth` / `x-host`，不是透传外部同名头。目标必须保留这个信任边界。                                          |
| 授权后端                     | `apps/relay/src/registry.ts:988`                                                      | `auth/authHash/authHost` 检查有效期、owner secret 版本、邮箱授权、管理员资格、API key 与 host 状态；部分成功检查更新 lastSeen。            |
| 缓存                         | `apps/relay/src/host.ts:428`                                                          | `authorized` 使用 5 秒缓存、相同 hash 的进行中请求合并和 128 项容量限制；未命中调用 Registry `authHash`。不是建连时快照。                  |
| 所有入站帧                   | `apps/relay/src/host.ts:2259`                                                         | `handleMessage` 在解析帧之前检查 deadline 并调用 `authorized(a.auth.hash)`，包括业务、ACK、管理回复和 Terminal。                           |
| 所有经 forward 的出站帧      | `apps/relay/src/host.ts:373`                                                          | `forward` 排队后再次检查接收方 deadline 与凭据；后端故障也可能使已有连接关闭。                                                             |
| Client → Agent               | `apps/relay/src/host.ts:2600`、`:627`、`:768`                                         | 普通业务、结果 receipt、command 还检查 Agent 凭据；请求方和接收方都可能触发检查。                                                          |
| 异步结果与握手确认           | `apps/relay/src/host.ts:923`、`:972`、`:1023`、`:1074`、`:1190`                       | `activateControl`、`complete`、`result` 再次检查授权；部分属于握手，部分属于稳定连接上的结果交付，需拆分。                                 |
| Terminal 输入 / resize / ACK | `apps/relay/src/host.ts:665`、`:697`                                                  | `terminalFrame` 检查 Agent，`validateTerminal` 检查 owner 并事务读取租约、控制证明、project writer；绑定以后仍按帧执行。                   |
| Terminal 输出                | `apps/relay/src/host.ts:2350`                                                         | Agent 输出到客户端前执行 `validateTerminal`，再经 `forward` 重验客户端；高频输出也承担权限与状态查询。                                     |
| Host 通知                    | `apps/relay/src/host.ts:641`、`:1400`                                                 | `changed` 经 `forward` 向订阅者发通知；`/notify` 的部分通知还检查 Agent。                                                                  |
| Registry 通知                | `apps/relay/src/registry.ts:180`、`:234`                                              | `subscribe` 建连检查；`publish` 每次向 owner 推送前直接调用 `authHash`，并检查订阅有效期，不使用 Host 的 5 秒缓存。device 订阅按 id 分流。 |
| 业务理解                     | `apps/relay/src/host.ts:726`、`:2650`–`:2809`                                         | 云端解析控制命令、delivery body、webCommand 与 lane，维护临时请求关联；尚不是仅授权和转发。                                                |
| 控制权                       | `apps/relay/src/host.ts` 的 `assertController`、`validateTerminal`、`activateControl` | 现有逐包代际、租约、project writer 检查保证旧控制端隔离；不能在没有替代机制时直接删除。                                                    |
| 撤销 / 断连                  | `apps/relay/src/host.ts:1477`、`:2913`                                                | `/revoke-auth` 清缓存并关闭匹配连接；正常 detach 发送前仍检查 Agent。移除逐包检查也须覆盖清理路径。                                        |
| HTTP 管理与查询              | `apps/relay/src/index.ts` 各 API、`host.ts:1457`、`:1505`                             | 每个 HTTP 请求检查调用者；status / configuration 还检查目标连接或再次验证管理员。它们与已建 WebSocket 的数据流不同。                       |

`common.ts:128` 起的 `registryCall` 在当前 DO 模式下走 RegistryDO；旧迁移兼容分支也保留通过 RegistryCore 读取 D1 的代码。因此不能把所有 `authHash` 都称为“跨 DO 请求”，也不能把每次 `authorized` 都算作一次数据库访问。DO 重建会丢失普通内存缓存，存活 socket 的 attachment 则用于恢复连接信息。

## 4. 问题与优先级

### P0：删除复查前必须替换动态授权的生效机制

当前撤销依赖主动关闭与后续复查共同生效。`index.ts:695` 起的 API key / credential / email grant 撤销会通知 Host `/revoke-auth`；邮箱名单更新也关闭受影响连接。其他变化，例如 owner 退出、owner secret 轮换、管理员邮箱变更及订阅失效，不能假设都已有完整、可靠的定向断连。

如果只删除 `authorized`，漏掉的撤销事件可能让旧连接继续使用旧权限。尤其 Registry owner 订阅当前依赖推送时复查，不能只改 HostRelayDO。

目标方案采用**授权变更触发连接失效**：撤销处理是独立控制事件，不由业务包触发授权检查。撤销发生后关闭连接，并使本地路由失效；不能在关闭握手完成前仍转发排队数据。连接失效不等于已经取消 Agent 上正在执行的任务。

### P0：握手、固定作用域与接管必须完整

WebSocket 101 不等于业务连接完成：Web 还需 ticket / attach，History 需 history-ready，Terminal 需 bind，delivery 需 OPEN / CONTROL_READY。CLI 的一次性 ticket 与当前租约也属于建连阶段。

建连状态机必须明确为 `pending → active → closed`，pending 只能接收握手消息。不能把历史查询、Terminal ACK 或每次 delivery-query 重新命名为“建连”来保留复查。

权限扩张或更换 host/session/project/terminal/角色须建立新逻辑通道并完成授权。Agent 复用一条物理 WebSocket 时，每个逻辑通道单独绑定路由与能力；禁止用物理 Agent 连接的一次准入自动授予任意 Client 会话权限。

接管时先使旧控制连接及其 Terminal 子通道失效、清除待转发队列，再完成新代际与 Agent 的握手。Agent 的持久控制代际仍负责拒绝已在网络中的旧命令。当前 `native/src/delivery.cpp` 的 `control_apply` / delivery 检查与 `native/src/agent.cpp` 的控制证明、Terminal 检查可作为基础，但不足以证明移除云端检查已安全。

### P1：逐包凭据检查与业务检查交织

稳定连接的数据流调用 `authorized`，异步结果路径又重复检查。对 Terminal 与广播，一条输入会导致多处检查；缓存失效、并发容量不足和后端故障会影响已建立连接。收益应以调用计数和端到端测量确认，不依据调用点数量推算倍数。

`webCommandSchema`、`rpcDeliveryLane`、`webDeliveryLane` 及正文解析承担业务语义。要达到“仅授权”，应将这些校验交由 Agent；云端保留握手能力协商、可信身份绑定和传输封装。迁移期间可以先消除凭据复查，但不能宣称已完成整个职责简化。

### P1：现行文档和测试明确要求持续检查

`TRANSPORT_ARCHITECTURE.md` 第 2 节要求备用入口、ACK、窗口查询与补发重新检查权限；这与新目标冲突。`relay-order.test.ts` 还覆盖授权缓存合并、撤销与正在进行的检查竞争、forward 后端失败关闭连接等行为。实施时必须同时更新契约和相关测试，不能只让旧测试继续通过。

## 5. 目标职责与生命周期

| 环节                  | 目标职责                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 建连 / 重连           | 验证 Access（启用时）、CoC 凭据、角色、host、浏览器身份与 Origin；消费 ticket；确定会话 / 项目能力、控制代际与 Agent 身份；完成双方握手。                  |
| 连接绑定              | 保存可信 principal、host、session、通道能力、连接代次、对端 route 与生命周期信息；外部包不能覆盖这些字段。仅保存所需身份摘要，避免把完整凭据复制到数据帧。 |
| 已建立数据流          | 不调用 `authenticate`、`authorized`、`authHash`，不查询邮箱 / key / host 权限、租约或 project writer；按固定路由有界转发，不解析内层业务语义。             |
| 传输防护              | 保留最大帧、队列上限、背压、关闭状态、绑定路由和最小封装检查。不能借机放开跨 host/session 的任意寻址。                                                     |
| 授权撤销 / 权限变化   | 控制事件使相关连接和队列失效；关闭握手、数据通道、History、Terminal、管理与通知连接。再次连接必须重新授权。                                                |
| 控制接管 / Agent 更换 | 原子退休旧绑定，向 Agent 同步新代际；不让旧连接在新代际确认前恢复写资格。                                                                                  |
| 端点业务              | Agent 权威执行 RPC 允许列表、项目和文件权限、沙箱、审批、命令分类、代际检查、去重、ACK、结果与恢复。Client 负责自身协议与持久状态。                        |
| HTTP                  | 每个独立 HTTP 请求仍须授权，HTTP keep-alive / HTTP/2 复用不能代表授权连接。高频业务转入已授权逻辑通道后，才享有不再逐请求鉴权的性质。                      |

### 5.1 有效期、撤销和休眠恢复

计划保留凭据有限有效期，但不在每个业务包上比较有效期。建连时确定连接截止时间，到期由一次性生命周期事件关闭；重新授权通过重连完成。现有 handshake 定时清理不能被当作已覆盖所有 active socket 的到期关闭。永久有效连接不增加周期查询。

这带来明确取舍：按包检查移除后，截止时间的实际执行依赖事件调度，不能声称严格零延迟到期；任何更严格承诺须单独验收。也不能默认凭据到期后旧连接永远有效。

撤销通知需有持久事件 ID / 版本、受影响目标、幂等应用及完成确认，失败重试不能靠下一业务包补查。UI 区分“凭据已撤销，新连接已禁止”与“所有旧连接已关闭”；未收到断连确认不能宣称即时撤销完成。跨 Registry / Host 的状态提交和事件投递必须可恢复，不允许先修改授权然后永久丢失断连事件。

建连和撤销并发时，使用控制面授权版本与连接登记屏障，保证不会在已处理撤销之后才激活旧快照。队列任务在每个异步边界后依据本地 closed / retired 状态丢弃数据；这里不查询授权后端。必须覆盖握手确认晚到、业务结果晚到与 close 回调晚到。

DO 休眠恢复使用 attachment 恢复已建立绑定；控制面的失效版本与退休记录须可持久恢复。若恢复时不能确认绑定完整，应关闭并要求重连，不能自动给旧连接补授权。缓存恢复的生命周期初始化可以一次执行，不能每个消息都读权限存储。部署跨版本的旧 attachment 若不兼容也必须显式重连。

## 6. 分阶段改进计划

| 阶段                | 工作与主要文件                                                                                                                                                                                     | 完成标准                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1：固定契约和基线   | 更新 `REQUIREMENTS`、`ARCHITECTURE`、`TRANSPORT_ARCHITECTURE`、`RELIABLE_TRANSPORT`；建立所有 WS / HTTP / 控制事件调用清单和 auth 计数基线。                                                       | 明确握手完成点、撤销 / 到期语义、逻辑通道边界，测试可区分握手与稳定数据流。                                         |
| 2：统一连接生命周期 | 在 `host.ts` / `registry.ts` 明确 pending / active / closed 与绑定版本；统一撤销、过期、接管、Agent 替换、队列退休和休眠恢复；补全撤销事件持久投递与确认。                                         | 对所有凭据变化和竞态，旧绑定不会重新激活；不依赖下一数据包检查。完成后才允许删热路径检查。                          |
| 3：去除数据流鉴权   | 拆分握手与业务回调；移除 `handleMessage`、`forward`、稳定结果、receipt、Terminal、通知、detach 对已建连接的授权复查；HTTP 准入仍独立检查。                                                         | 长连接跨越旧 5 秒缓存窗口，双向业务 auth 查询增量为零；授权后端故障不因数据转发而关闭已有连接，新准入失败时仍拒绝。 |
| 4：收缩业务职责     | 将正文解析、读写分类、lane 校验移至 Agent；控制权在握手 / 接管时固定，按包租约事务替换为固定绑定与事件退休；业务可靠性留在端点。涉及 `host.ts`、共享协议、native Agent / Client 与 Web transport。 | 云端不解析内层命令，不读取权限表或租约来决定每包可否执行；伪造命令、旧代际及越权业务由 Agent 拒绝。                 |
| 5：回归与交付       | 增补测试、更新 `USER_GUIDE`、`TEST_REPORT`、`CHANGELOG`；执行相应静态检查、native / web / Worker 构建及集成测试。                                                                                  | 所有验收项有证据，明确不兼容连接的重连策略、回退方式与未验证范围。                                                  |

每阶段单独评审。协议语义不兼容时新增明确能力协商；不静默让旧客户端进入新转发模式。发布需按仓库要求等待对应提交的全部必需 CI 成功并使用验证制品；本计划不授权发布 Worker 或重启活动任务。运行中任务不得因传输改造被重新执行，结果不明继续沿原请求身份恢复。

## 7. 验收清单

1. **准入拒绝**：无效 / 过期凭据、错误角色、host、Origin、邮箱身份、重复 ticket、旧 ticket、握手超时及伪造内部头均不能取得 active 通道。
2. **零逐包鉴权**：握手后清零计数，持续超过 5 秒发送普通 RPC / Web 命令、delivery DATA / QUERY / CONTENT / RECEIPT / WINDOW、History、Terminal 输入 / resize / ACK / 输出、Host 与 Registry 通知。无独立控制事件时授权后端查询增量必须为零；不要只断言 `authorized` 不被调用。
3. **零逐包权限存储读取**：稳定流不读取 lease / project writer / credential；仍可做固定路由及有界队列检查。覆盖 DO 恢复后的第一帧及后续帧，单次生命周期恢复与逐包查询分别计数。
4. **端点隔离**：伪造 owner / route、跨 host/session/project/terminal、错方向、读通道写命令、错 lane、旧控制代际均失败；Agent 保留允许列表、沙箱与显式审批。
5. **撤销矩阵**：credential、API key、Agent 级联、邮箱 grant / 名单、管理员邮箱、host 禁用、退出、owner secret 轮换均覆盖；包含管理和通知 socket。验证事件投递失败、重试、重复、乱序及 DO 重建，不遗漏旧连接。
6. **竞争与排队**：撤销与握手同时发生、接管与 input 并发、旧 Agent 重连、转发队列等待、Agent 晚回复、close 尚未完成时，旧绑定不能继续派发。已开始任务不被误报为已取消。
7. **有效期**：active 连接到期在独立事件关闭；空闲永久连接无周期授权查询；断线后的新连接重新授权，旧快照不可重用。
8. **后端故障**：已建立数据流不因 RegistryDO 授权查询失败而中断；新连接不得绕过授权；撤销未送达状态必须可见并可重试。
9. **可靠交付与资源**：保留 delivery 原请求恢复、去重与结果读取；超大帧、零字节洪泛、慢读端、广播与大量连接不能突破队列上限。
10. **测量**：在相同连接数、帧率、方向、广播规模和存储后端下比较 auth 调用、权限存储操作、帧耗时与端到端 P50/P95/P99。区分建连、稳定传输、撤销与重连成本，不将数据库查询归零等同于全部云端成本归零。

现有测试入口以 `tests/relay-order.test.ts`、`tests/device-auth.test.ts` 为基础，扩展 Registry 订阅与生命周期测试，并通过 `test:e2e`、`test:terminal:e2e`、`test:delivery` 覆盖真实端点链路。具体执行结果写入 TEST_REPORT；本次只有第 2 节列出的两组测试已执行。

## 8. 本机实施记录

- 已实现连接退休标记、升级时最终授权版本检查、授权配置摘要恢复、active 连接到期事件、授权变更持久事件及失败重试。
- 已移除稳定数据帧、双向转发、Terminal 绑定后、通知和断连清理中的凭据复查；普通控制数据使用固定连接绑定，不按包查询租约。
- Worker 移除原始 Web/RPC 正文格式、读写和 lane 的重复校验，使用 Agent 已有权威校验。握手、HTTP 准入与传输封装 schema 保留；没有取消帧限制、背压和可信身份绑定。
- 授权变更采用全目录保守广播，尚未实现专门的在线连接索引；大目录的变更成本和端到端 P50/P95/P99 尚未测量。这个限制不会把鉴权重新放回业务包路径。
- CI、生产部署及线上收益不属于本次本机实施结果。跨版本旧连接按摘要检查关闭重连，既有任务不自动重新执行。
