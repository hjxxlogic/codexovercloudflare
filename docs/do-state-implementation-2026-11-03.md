# DO 存储实施 · 2026-11-03

授权、目录、主机控制状态和权限回执由原生 SQLite-backed DO 保存。`STATE_BACKEND=do` 不再执行 D1 直读、离线回执确认、离线归档或 D1 Cron。旧后端仅用于迁移兼容和回归，未删除源数据库。

Registry 首次使用前分批复制 D1，完成后提交 `@doState`，失败不得提供半成品授权。Host 复用已验证的旧权威状态恢复流程，提交本地标记后退出 HostLifecycle；活动 epoch 不被旧归档覆盖。Registry 的一次性 alarm 每页四个主机，合并本地目录和 D1 全部 Host scope，完成后写 `@doHostsDone` 并停止；失败保留游标、60 秒后重试。终态输出 `do_migration_complete`。迁移版本必须保留原数据库，禁止回滚到继续写旧 D1 的版本。

网页终端删除 15 秒应用 ping。配套 Agent 上报 `streaming:2`，只有未绑定流的 PTY 才按最后活动超时；断流更新 60 秒恢复宽限起点，已有控制权与会话清理不变。Relay 和网页要求新能力，旧 Agent 需升级才能开启终端。原生协议 Ping/Pong 继续运行。空闲链路异常由网络关闭、页面恢复或实际操作发现，不重放未知终端输入。

稳定空闲窗口排除真实业务、用户查询、撤销、安全期限、连接关闭和迁移事件。有限 alarm 仍可能产生计算用量；持久存储有独立费用。本地无应用消息测试不能证明线上账单零用量，30 分钟以上平台计费窗口及长期稳定性需另行采集。

本次按用户明确要求跳过 GitHub Actions，通过本地构建的仓库部署脚本发布，证据必须标记 `ciVerified: false`；不发布原生下载站或发送自动升级通知。生产 D1 导出保存在忽略目录 `.local/do-migration-2026-11-03/`，导入内存 SQLite 完整性检查为 ok，423 条状态、19 个 scope；该快照不含活动 DO。

验证：35 个 Vitest 文件 / 493 项、10 项 CTest、15 项部署脚本回归、类型与格式检查通过；真实 Wrangler 反向迁移含完整主机完成标记、完整原生 / Chromium E2E、终端 65 秒空闲存活且无应用帧均通过。完整设计取舍见 [评估](d1-do-simplification-review-2026-11-03.md)。

运维可显式读取 `/api/v1/healthz?stateMigration=1`，仅返回后端和全部主机迁移是否完成，不返回业务状态或凭据；普通 health 不访问 DO。`scripts/deploy-cloud.py --local-build --retire-state-db --apply` 会先读取线上完成状态，未完成拒绝移除绑定；只有完成后才发布无 D1 绑定的 Worker。该操作保留数据库本身。根配置应同步去除绑定，防止后续发布重新引入。

第一阶段源码 `d9451b46063de69fe19ad2abd9b7d4d220733d80` 已部署至 `https://r.xlogic.cc`，Worker 版本 `b9814c9b-cdae-45ee-87f6-ea5cd552071d`。健康及资源字节校验通过，线上明确返回 `{"backend":"do","complete":true}`。随后根配置移除 D1 绑定，由部署脚本再次在线验证完成标记后发布。原数据库保留，不执行 DROP / DELETE。最终部署身份和摘要见后续证据。

迁移完成后，新代码拒绝把已有 `@doState` 的对象切回 `d1` 或旧模式，防止配置误改复活旧授权；无 D1 时也只在首次初始化写主机迁移完成标记，避免每次休眠重建重写。
