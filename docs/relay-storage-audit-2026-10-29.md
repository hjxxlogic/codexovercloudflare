# HostRelayDO 存储审查 · 2026-10-29

状态：完成源码和平台只读清单 / 指标核查，修复空对象的无必要写入；未部署修改、未删除生产对象或其内容。

## 平台快照

2026-10-29 07:19 UTC（北京时间 15:19）通过 Cloudflare REST API 分页读取本项目命名空间清单；请求没有进入任何 HostRelayDO 的 fetch / WebSocket handler。24 小时指标窗口为 `[2026-10-28T07:19:52Z, 2026-10-29T07:19:52Z)`。

| 项目                            | 数量 |
| ------------------------------- | ---: |
| HostRelayDO 对象总数            |   36 |
| hasStoredData: true             |   27 |
| 有数据且窗口内有请求 / 周期指标 |    4 |
| 有数据但窗口内未观察到活动      |   23 |
| hasStoredData: false            |    9 |
| 无数据但窗口内观察到活动        |    0 |
| RegistryDO 有数据对象           |    1 |

与用户提供的 24 有数据 / 12 无数据清单不同，这是新的时间点，不能把数量差异解释为本次清理效果。本次未调用 deleteAll 或生产删除接口。

`durableObjectsSqlStorageGroups.max.storedBytes` 按 namespaceId 聚合：HostRelayDO **598,016 字节（584 KiB）**，RegistryDO **36,864 字节（36 KiB）**。这是窗口内命名空间存储的最大值，不是当前精确用量或单对象大小，也不是账单。当前证据不支持“HostRelayDO 是本项目唯一实际存储的命名空间”。该存储指标的 schema 没有 objectId，不能据此分配每个对象的字节数。

## 对象与引用路径

`hostStub()` 使用 `HOSTS.idFromName(hostId)`：每台主机一个 DO，多个会话共用。并非每次 relay session 新建对象。会话退出或页面关闭不是整个对象生命周期结束。

- 当前主机 / Cookie 列表在调用 Host 前通过 Registry 的有效主机及授权验证；已撤销凭据不会让旧 Cookie 继续查询该主机。
- 会话路由仍允许有效授权读取已结束会话历史，这是保留的受支持行为，不能按“会话结束”判定所有引用过期。
- 发布广播仅枚举当前协议且未停用的主机；其他通知以明确受影响主机为目标，包括撤销时关闭连接。有效但没有连接的主机也可能收到通知。
- 常规空闲没有周期对象扫描或连接鉴权 alarm。票据、握手、临时回执依真实期限索引清理；已有对象第一次请求可能进行有界旧票据迁移。
- 无数据对象在该窗口中未观察到请求 / 周期活动，没有证据显示当前代码持续轮询这些对象。Analytics 有延迟及可能采样，未观察到活动不等于永久无效。

## 保留数据及清理边界

| key 类别                     | 用途 / 生命周期                                                             |
| ---------------------------- | --------------------------------------------------------------------------- |
| agentEpoch                   | 主机连接版本；保留以拒绝旧连接帧                                            |
| lease:*                      | 各会话控制 epoch 与租约 / 预留状态；断开标记 inactive，不能仅因断开重置版本 |
| operation:_、part:_、wire:*  | 有限期异步回执和分段数据；alarm / socket 关闭按现有逻辑回收                 |
| ticket:_、handshake:_、due:* | 有限票据、握手和期限索引；到期处理                                          |
| revision                     | 当前主机通知版本                                                            |
| wakeUntil                    | 唤醒一分钟去重窗口                                                          |
| expiryMigration              | 旧票据索引迁移进度                                                          |

模型完整历史保存在 Agent 本机，不是这 27 个对象里的会话历史库。REST 清单只返回 opaque ID 与 hasStoredData，不返回 KV 内容、是否可删除、hostId 对应关系或当前 socket 列表。本次逐对象将清单与 24 小时 objectId 活动指标关联，未读取生产 KV 内容。因此 23 个未观察到活动的有数据对象仅是进一步核查候选，不能宣称其会话已结束或已经清理；应先证实对应主机永久停用、无有效凭据 / 在途工作，并制定不会重置有效 epoch / 租约的迁移方案。

`storage.deleteAll()` 会清空整个对象的数据库；当前 compatibility_date 为 2026-10-24，确实也清除 alarm。不能在一个会话的 sessionClosed 或 socket 断开处理器中调用它，否则会删除同主机其他会话的租约、回执和连接版本。hasStoredData: false 不能单独证明内部元数据字节为零或对象已被平台回收；若对象曾写入后逐键删除，官方要求通过 deleteAll 完整清空存储。对这些对象也应先确认生命周期和关联主机，再从对象内部执行清空；当前没有安全的已部署逐对象清空入口。本次不为强制回收而逐个唤醒对象或新增维护轮询。

## 已修复与验证

发现两个可复现的存储物化路径：首次只读 `/status` 因 migrateExpiry 写空的迁移完成标记；无人连接的 `/notify` 因 changed 写 revision。修复后，首次发现存储完全为空时仅在内存记住无需迁移；新临时记录仍由 expireAt 建立期限索引。没有 socket 的通知不写 revision，后来的订阅者读取最新快照；已有 revision 不被重置。既有有数据对象仍按原流程迁移和清理，不在本次变更自动删除。

回归覆盖空对象的状态 / 通知 / 撤销不写入、不设 alarm，重建后仍不写空迁移标记，以及跳过迁移后新票据仍正确调度。全量 Vitest、类型及格式检查记录于 TEST_REPORT。原始对象清单、按对象关联结果、schema 与指标保存在忽略的 `.local/relay-storage-audit/`；公开文档只记录聚合结果，不包含凭据或机器局部标识。线上节省效果需在经 CI 发布后另行观测。

## 官方依据

- [对象枚举 API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)：清单字段与游标分页。
- [存储访问与回收](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)：空对象与 deleteAll 的区别。
- [2026-02-24 deleteAll 行为变更](https://developers.cloudflare.com/changelog/post/2026-02-24-deleteall-deletes-alarms/)：新兼容日期同时清除 alarm。
- [指标与分析](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)：平台指标口径。
