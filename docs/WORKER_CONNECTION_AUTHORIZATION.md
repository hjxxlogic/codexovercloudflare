# Worker 连接授权契约

[文档索引](README.md) · [审计与计划](WORKER_AUTHORIZATION_AUDIT_2026-11-03.md)

状态：已上线，源码及验证见 [发布记录](DEPLOYMENT_STATUS.md)。Worker 指入口、RegistryDO 和 HostRelayDO，唯一存储路径为 DO 原生存储。D1 / legacy 后端、归档恢复、迁移接口及对应开发、部署和测试入口已从代码中移除，详见 [清理记录](DO_ONLY_STORAGE_2026-11-03.md)。

## 准入与数据流

HTTP 请求分别验证调用者，HTTP keep-alive 不保留授权。WebSocket 在升级时验证角色、凭据和主机；Web ticket/attach、History ready、Terminal bind 和 delivery OPEN/CONTROL_READY 完成各逻辑通道的作用域与控制权握手。握手中的租约事务继续保留。

握手完成后，双向业务、结果、ACK、History、Terminal 和通知不再查询凭据、邮箱、API key 或主机权限。普通数据转发不读取租约或 project writer。Worker 绑定可信身份和路由，保留帧大小、通道封装、队列和背压限制。正文与 lane 的业务检查交由 Agent；Agent 已在接收路径校验命令格式、可靠写入要求、lane、控制代际、允许列表、沙箱和显式审批。HTTP 管理及查询仍可查询权限和当前租约。

逻辑通道重新 OPEN 是握手；不能通过已有连接改变其 host/session/角色。Worker 的控制握手、HTTP 命令封装和通知格式仍有 schema 校验，本次没有改造为通用任意字节代理。

## 生命周期

`connections.ts` 的退休标记先写入 socket attachment，再开始关闭握手；关闭中的 socket 即使暂时仍报告 OPEN，也不能继续派发。接管预约提交后立即退休旧控制连接及 Terminal 子连接。Agent 更换使旧 Agent 与关联业务连接失效。Agent 仍负责隔离已送到本机的旧代际命令。

有效期在建连或握手完成时登记一次性到期事件，alarm 关闭到期连接；普通数据帧不再比较有效期。实际关闭受 alarm 调度影响，永久凭据不新增周期查询。

Attachment 保存授权配置摘要、退休状态及绑定信息。休眠恢复不重新查询凭据；遇到旧格式 attachment、配置摘要变化或未完成的控制面阻塞状态，关闭并要求重连。部署本改动会使此前未保存摘要的连接重连。摘要只写入 attachment，不对客户端公开。

## 授权变更

凭据撤销、key 撤销、邮箱授权及管理员变更、退出等操作在修改权限前保存带唯一 ID 的持久失效事件及 alarm 索引。Registry 按事件通知 Host；Host 暂停已有路由，在控制事件中复核一次并退休失效连接，保留仍有效的连接。此复核由授权变化触发，不由业务包触发。后端在此时故障，相关连接按失败关闭。

成功通知并处理 Registry owner 订阅后删除事件。投递失败保留事件，5 秒后重试；API 返回 `INVALIDATION_PENDING` / HTTP 503，表示权限可能已经修改但旧连接失效尚未确认。调用者应刷新状态，不能将该错误当作修改已回滚。事件可能重复投递，处理保持幂等；回执不是端到端业务执行 ACK。

当前 DO 实现的广播采用保守方式：遍历主机目录并联系全部 Host。这增加授权变更时的成本，避免业务热路径查询；本次没有宣称授权变更规模成本得到优化。业务流在授权后端故障时继续转发；新的准入仍必须授权成功。

配置或 owner secret 轮换通过恢复时的摘要变化使旧连接重连。关闭连接和撤销入口资格不代表已经取消 Agent 上的任务；已开始工作保留真实结果，恢复沿原请求身份进行。

## 实现与验证入口

源码：`apps/relay/src/connections.ts`、`host.ts`、`registry.ts`。Agent 的校验位于 `native/src/agent.cpp` 与 `delivery.cpp`，本次无需修改原生协议。

测试覆盖超过旧 5 秒缓存窗口及 DO 重建后的双向转发、无权限存储读取、后端故障、退休连接晚到数据、授权控制事件、active 连接到期及持久事件失败重试。Worker 的传输封装仍保留，不新增业务持久 ACK。实际检查结果与尚未验证范围见 [TEST_REPORT](TEST_REPORT.md)。

## 重连确认丢失

重连的 socket 身份提交先于客户端收到确认。租约保留本次已经验证的原 controller；同一认证 owner 也可用当前 controlId 的随机 claim 与原 delivery stream 恢复，修复旧实现遗漏 controller 后的租约。检查不能跨 owner、消息流或已被接管的新 claim；pending 接管的代际隔离继续生效。普通恢复不提高控制代际，只分配新连接代次。详见 [断网恢复修复](WEB_RECONNECT_2026-11-03.md)。
