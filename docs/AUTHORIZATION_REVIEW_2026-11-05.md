# 授权复核审查（2026-11-05）

核查范围为 master `94a641555d9dfa34dc52bb9cfbcea70a7df0ec96` 与 opaque 分支 `ca1ee96bb74543aa01d1d6456113ace13462ddaf`。本次仅修复 master；opaque 分支的问题仍未修复。

## 结论与复现

| 问题 | opaque 分支 | master |
| --- | --- | --- |
| 无关凭据变更期间丢帧 | 已复现；secretstream 下一记录解密失败 | 已复现；Agent 回复丢失后请求仍 pending，重发原回复才完成；转发队列也丢帧 |
| 端点确认前永久断线导致失效记录不结束 | 已复现；模拟 30 天及 DO 重建后，新事件仍返回 INVALIDATION_PENDING | 没有该机制；离线 Agent 的连续三次授权变更均返回 200，无 retirements |
| 全 Host 广播、任一失败重试全部 Host | 存在 | 存在，本次不调整 |

opaque 的 `HostRelayDO.invalidate` 先标记全部连接 blocked，再串行查询 Registry；`message` 和目标查找依赖 `live`，会跳过 blocked 连接。复现延迟 authHash，分别在源阻塞和源已恢复、目标仍阻塞时送帧，均未转发。复核成功也不补发；真实 SecureChannel 的下一条记录解密失败。已有“preserves an unrelated authorized channel”只在复核完成后送帧，未覆盖复核期间。

opaque 的 Retirement 不含到期时间，清除只依赖原 socket 确认或同类同目标注册。端点在确认前断开会保留记录；改变事件 ID、DO 重建及推进 30 天均不能消除 503。manager 的 target 包含 instance，新 instance 不匹配旧 target。Registry 任一 Host 失败便保留事件，每 5 秒重新联系全部 Host。故障会持续影响后续授权变更完成，但“所有 API 永久失败”需限定为仍会投递到该故障 Host 的授权变更；凭据修改可能已经提交，503 不代表回滚。单独给记录加 TTL 并不足以证明旧端点已隔离，需配合连接或实例生命周期栅栏。

master 同样全连接 blocked、串行复核，`handleMessage` 和 `forward` 原来直接跳过非 live 连接。现有交错刷新测试甚至验证了阻塞期间不发送，却未验证稍后补发。本次复现确认该丢失存在；master 不使用 opaque secretstream，因此不能把加密通道解密失败的具体影响直接套用。master 没有端点 retirement ACK 状态；离线端点本身不会导致同类永久等待。Registry 的无限重试放大仍是独立待改进项，持续 Host 控制故障可导致事件长期保留。

## master 修复

入站沿用有界有序队列等待授权复核；转发和直接发送共用有界转发队列，保留顺序及源、目标退休检查。异步处理的存活检查等待最新复核，attachment 保存保留当前授权栅栏。最新复核通过后释放，旧代次不能恢复或退休连接；真实撤权丢弃缓冲并关闭连接。控制异常关闭仍阻塞连接、释放等待；超限显式关闭。缓冲不持久化，DO 重建继续关闭未完成复核的 attachment。

新增持续事件流、原 Agent 回复、排队与新发送顺序、撤权、输入及输出超限验证，更新交错刷新和控制异常用例。生产部署必须等待包含修复的准确提交全部 CI 门禁通过。

机器复现源码、输出及发布日志保存于忽略目录 `.local/release-0.6.7-20261105/`，其中 opaque 两项和 master 三项最小行为复现通过，均未访问生产业务或调用模型。后续验证和实际部署结果记录在 [发布操作](RELEASE.md)。
