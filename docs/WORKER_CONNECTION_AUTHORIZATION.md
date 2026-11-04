# Worker 连接授权契约

[文档索引](README.md) · [可靠传输](RELIABLE_TRANSPORT.md) · [不透明中继设计](OPAQUE_RELAY_DESIGN.md)

Worker 指入口、RegistryDO 和 HostRelayDO。RegistryDO 保存角色、邮箱、凭据、主机授权和持久失效事件；HostRelayDO 只保存连接身份、路由、失效确认与唤醒冷却，不保存会话、业务 ticket、项目写锁、请求关联、正文或业务结果。

## 准入与稳定转发

控制面 HTTP 每次授权。Agent/CLI 管理上行和通用 Client 通道在 WebSocket 升级时绑定凭据与主机；Worker 按现有规则计算普通访问、项目管理、owner 配置权限。公开 key 与新的 link 通过已认证上行送到端点，绑定 owner、role、accountId、permissions、hostId 和 expires。业务正文不能覆盖该身份。

稳定数据帧只检查来源连接、目标路由、外层格式、帧大小和队列预算，不查询 Registry，不解密或分发业务。逻辑会话、历史、Terminal、控制证明及可靠窗口均在加密通道内由端点处理。Worker 的协议依赖仅为 `packages/protocol/src/admission.ts`，不导入业务 schema。

每 Host 最多 256 条连接，握手截止 15 秒；密文帧最大 256 KiB，处理中队列最多 1024 条 / 8 MiB。映射失效、过载或不合法封装关闭连接，不丢弃中间密文后继续转发。目标离线等连接错误可以公开返回，业务错误只能加密返回。

## 生命周期与撤销

`connections.ts` 先在 attachment 写退休标记，再进行关闭握手；关闭中仍报告 OPEN 的连接也不能转发。凭据有效期登记一次性 alarm，并在接收时检查；端点独立检查到期和派发资格。永久凭据不增加周期授权查询。DO 恢复保留符合版本与策略摘要的连接，旧格式或摘要变化关闭并重新准入。

撤销、邮箱/管理员变化和退出先保存 Registry 持久失效事件。Host 暂停已有路由，在该控制事件中重新验证连接身份及已绑定权限，保留未变化的连接，退休身份或权限已变化的 Client 连接，并持久保存须由端点确认的 link 退休记录。尚未注册的失效上行没有接收过业务绑定，直接关闭；已注册上行自身失效时发送 `link: "*"` 屏障，端点先清除旧绑定及未开始派发资格，再发送 `channel-retired`。

只有与记录绑定的目标 socket 和事件匹配的确认才有效。仅失效的绑定要求该确认，未变化的绑定恢复转发且不重做业务握手。失效处理等待该确认；5 秒超时、目标缺失或后端故障返回 `INVALIDATION_PENDING`，保留记录供 Registry 重试和 DO 重建恢复。新上行注册意味着原生端点已在断线时丢弃全部旧 link，可确认同一进程目标的旧连接记录。策略已写入但确认失败不能视为回滚。

Agent 在同一业务执行器处理退休和命令派发，确认后旧绑定不能新开始工作。撤销与断线不伪装取消已开始的任务，结果仍保存在 Agent 并按原请求恢复。接管与项目单写由 Agent SQLite 仲裁，与 Worker 权限失效确认分开。

## 验证入口

`tests/relay-order.test.ts` 验证稳定流不查询 Registry、角色/主机绑定、异步握手排序、注入和晚到帧、到期、撤销确认丢失及 DO 重建。`native/tests/endpoint.cpp` 验证加密身份、控制仲裁与派发屏障；真实 Agent/CLI/浏览器集成覆盖业务恢复。具体执行结果见 [测试说明](TEST_REPORT.md)。
