# D1 / DO 简化与休眠计费评估 · 2026-11-03

评估基线：`1601832207041db9f3a3a98cc773b1f0f674eb41`。本次为源码、既有测量记录和 Cloudflare 官方文档审查；没有修改业务实现、读取生产状态、运行新计费实验或部署。

## 结论

可以将当前 D1 承担的功能全部移入现有 SQLite-backed Durable Objects。建议保留 RegistryDO 和每主机一个 HostRelayDO，移除双存储权威切换、D1 KV 模拟事务和离线归档。当前没有发现必须依赖 D1 的业务查询或数据规模要求；主要收益是降低正确性和运维复杂度，不能直接承诺总费用下降。

WebSocket 休眠不依赖 D1。持久状态留在 DO 不会因为“有数据”而阻止休眠。必须另行满足“稳定空闲连接不主动产生计费消息、请求和周期唤醒”的约束。当前网页终端心跳不满足该约束，移除 D1 本身不会修复它。

## 当前职责与复杂度

| 模块 | 当前实现 | 纯 DO 的处理 |
| --- | --- | --- |
| Registry | D1 保存授权、目录、配对、邮箱关联；部分 Worker 读取绕过 RegistryDO | 通过 RegistryDO 访问本地原生存储，保留事务和撤销通知 |
| 在线 Host | 已经使用 DO 本地存储；连接由 Hibernation API 接管 | 基本保持，继续保存 epoch、租约、票据和权限回执 |
| 离线 Host | 无连接、无在途工作持续 60 秒后完整归档到 D1 | 状态原地保留；不搬迁、不清空整个对象 |
| 离线状态和权限回执 | Worker 检查 D1 所有权，直接读或确认 | 请求进入所属 Host DO，按本地事务处理 |
| 清理 | 本地 alarm 加 D1 每小时 Cron | 按期限的有限 alarm，或严格校验到期后按访问机会清理 |
| 运维 | D1 绑定、schema、归档与活动 DO 双份备份边界 | DO 恢复流程、迁移审计和明确的备份工具 |

具体证据：

- `apps/relay/src/state.ts`：D1 实际使用 `(scope,key,value)` JSON KV；`relay_scopes` 修订号、CAS、最多八次重试、事务内读取缓存和本地排队用于重建事务语义。`migrations/d1/0001_relay_state.sql` 没有领域关系表。
- `apps/relay/src/host-lifecycle.ts`：claim、restore-clear、restore-copy、active、archive-clear、archive-copy、publish 七阶段，以及 token、游标、权威位置和故障恢复，主要服务于跨库搬迁。
- `apps/relay/src/common.ts`：Registry 直读、Host 状态和连接判断需要按后端及权威位置分流；`host-state.ts` 额外维护离线权限回执和跨 scope 到期扫描。
- `host.ts` 的 `inactive()` 明确要求不存在任何未关闭 WebSocket。**连接保留但 DO 休眠时不会归档**，所以 D1 归档不是当前在线空闲节费的来源。
- 普通模式已有原生 DO 存储实现和回归路径，证明业务接口可由 DO 提供；但不能据此把已迁移的生产数据直接切回普通模式。

既有 [10 月 31 日测量](d1-usage-2026-10-31.md) 记录 D1 为 168 KiB、397 条状态、19 个 scope，其中 Registry 108 条。已有 [DO 存储审查](relay-storage-audit-2026-10-29.md) 记录 Host 命名空间存储峰值约 584 KiB。两者是不同日期与窗口，不能相加或当作当前快照，但均不支持为容量建立冷热分层的必要性。

D1 的实际价值是让 Worker 无须调用 DO 即可读取目录和离线数据，并提供集中查询、导出入口。移除后这些访问会变为 DO 请求，单 Registry 的负载和远距离访问延迟也需测量。现在不能把 D1 查询数直接换算成新增 DO 请求数：一次 API 调用可能包含多条 SQL，且既有缓存、通知和事务会改变比例。

## WebSocket 休眠的硬约束

Cloudflare [计费文档](https://developers.cloudflare.com/durable-objects/platform/pricing/) 区分请求、运行时长及存储。符合休眠条件的空闲对象不累计运行时长；HTTP/RPC、alarm 和应用消息仍有各自用量；协议 Ping 不计入请求，出站 WebSocket 消息不收请求费。保存数据仍有存储用量。因此应验收“没有空闲保活带来的计算请求和运行时长”，不能表述为“保存数据并连接就绝对零费用”。

[WebSocket 文档](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) 明确协议 Ping/Pong 由平台处理、不进入消息 handler、不打断休眠。应用层 JSON ping 不享有该语义。`setWebSocketAutoResponse()` 可以避免处理自动回复所需的运行时长，但不能仅凭这一点承诺应用消息请求用量为零。

[对象生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) 要求无未完成 handler / I/O、无 JS 定时器回调、无标准 WebSocket API 阻碍。存储 alarm 与常驻 JS timer 不同：预定到期不要求持续驻留，但触发时会唤醒并产生请求用量。

源码核查结果：

1. Host 和 Registry 均使用 `ctx.acceptWebSocket()`；应保留，不能换成普通 `ws.accept()` 或 DO 主动发起的出站 WebSocket。
2. `native/src/socket_impl.hpp` 使用 `async_ping`，30 秒协议保活与 90 秒 Pong 超时在本机运行，符合不唤醒 DO 的方向。
3. **当前缺口：** `apps/web/src/workbench/terminal-stream.ts` 每 15 秒发送 `{type:'terminal-stream',frame:{type:'ping'}}`。Host 的 `terminalFrame()` 校验授权、控制权后转发，Agent 返回 pong，浏览器还可能回复转发回执。即使终端无输入输出，也有周期业务帧。仅浏览器起始 ping 就是每连接每天 5,760 条，尚未计算返回和回执。应去掉无业务时的周期 ping，使用实际输入/输出的超时与重连、页面恢复时按需验证；恢复前必须重新校验授权和控制权，不重放结果未知的终端输入。这会改变空闲断链的发现时机，需要明确验收。
4. `native/src/cli.cpp` 虽每 10 秒执行 `recover_reader()`，但稳定且 revision 已同步时不会读取历史；仅异常、重连或 revision 落后才访问网络。不能按定时器频率认定存在周期 DO 请求。既有文档中的“每 10 秒刷新”需在实现变更时校准描述。
5. 到期索引现在可设置 alarm。无待处理记录时 `nextExpiry()` 删除 alarm；票据、握手、临时回执仍可能触发一次或多次有限清理。**如果要求所有空闲窗口绝无 alarm 用量**，必须把可延迟的物理清理改为按需，并在每次读取严格检查 expires；握手超时、有限凭据到期断连等必要安全事件不能静默取消，应作为结束休眠的事件单独计量。
6. 普通模式 `hostHasConnections()` 总返回 true，通知可能唤醒离线 Host；`hostStatus()` 也需要读取 Host。移除 D1 后必须禁止定期全主机状态扫描，把通知限制为真实变更和受影响目标；用户主动要求新鲜状态仍是正常计费请求。不应为省一次唤醒再造一套带租约、心跳的全局在线目录。
7. `management.ts` 的 20 秒 timer 仅在实际管理请求期间存在，完成后清除；这是在途工作，不能把它当成稳定空闲连接，也不应改为无限等待。

严格定义的稳定空闲验收窗口：连接握手完成、无待处理业务和安全到期事件、无用户查询、无发布或撤销通知，仅保留协议 Ping/Pong。这个窗口内不应出现应用消息、内部轮询、迁移/归档或周期 alarm。外部请求、消息、关闭或安全事件到达后，对象可以正常唤醒并计费。

## 推荐实现与迁移顺序

1. 先修复终端空闲应用心跳，建立 A、A+CW、A+CC、A+空闲网页终端的空闲流量基线；不要把存储替换和节费效果混为一个指标。
2. 保留现有两类 DO、原生 KV 风格 API 和业务事务，不必顺带改写所有数据为 SQL 表。删除常态冷热搬迁后，epoch、撤销、项目写者和权限回执继续由原 Host 管理；模型历史继续归 Agent，不能搬到 DO。
3. 引入明确的新存储版本和可恢复的反向迁移。Registry 当前只保留 `@d1Migrated`，真实授权已不在本地，必须完整导入。冻结或串行化相应写入，分批复制、校验并提交权威标记，切断 Worker 旧 D1 直读/确认路径；不能允许迁移过程中并发修改归档源。
4. Host 按 `@location` 和本地 phase 判断权威源。DO 活动状态原地接管；D1 权威归档先导入；未完成 publish/restore 必须恢复到明确状态再转换。绝不能拿过期 D1 副本覆盖活动 DO，或重置 epoch、租约、已确认回执。
5. 先以兼容迁移版本保留 D1 绑定和只读恢复副本；完整枚举 Registry 主机和 D1 host scope，处理遗漏/孤立 scope 并完成验证。惰性迁移只能作为中间步骤，未访问主机尚未迁移时不能删除 D1。回滚到继续写旧 D1 的版本也不安全。
6. 更新 `scripts/deploy-cloud.py`、构建制品、Wrangler、CI 和运维文档。目前部署脚本会注入 D1 配置，删除源码依赖却不改脚本不能完成退役。建立 DO 数据恢复和导出验证；现有 `scripts/state-backup.py` 只备份 Agent 本机 SQLite，并非云端 DO 备份。
7. 待全部数据和旧读写路径退出后，才移除 D1 Cron、绑定及生产数据库依赖。数据库实际删除应作为另一个明确操作，不能借简化顺手删除。

## 验证要求与本次边界

- 数据回归：配对、邮箱授权、API Key、撤销、跨主机隔离、控制接管、票据一次性、权限回执确认、epoch 单调性、迁移中断与并发、冷启动和休眠重建。
- 连接回归：重建后从 attachment 和本地持久状态恢复；撤销后关闭相关连接；没有历史变更时 CLI 不发送同步请求；空闲终端没有应用心跳；临时事务结束后 alarm 收敛。
- 平台验收：独立测试主机在有限到期记录清理完毕后运行至少 30 分钟空闲实验，再做较长窗口验证。按对象/版本区分 HTTP、应用 WS、alarm、行读写和 billable duration；观察本机协议 Ping/Pong 与断网重连。不要用 WebSocket HTTP wallTime、采样日志缺失或“未超过免费额度”证明零计费用量。
- 真实业务期间、有限到期和外部事件单独计量。普通本地测试可以断言无应用发送及重建正确，不能证明 Cloudflare 账单结果。

本次仅完成审查和方案文档，没有执行上述新增回归或线上计费实验。推荐实施纯 DO，但应先满足空闲流量约束，再验证迁移和整体成本；现状不能宣称所有 WebSocket 场景都已达到空闲零计算流量。
