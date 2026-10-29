# D1 持久状态与在线中转

2026-10-29，已通过 CI 制品部署 D1 模式；线上并发连接暴露 scope 事务竞争，正在修复验证，尚未完成稳定性验收。

## 职责与一致性

启用 `STATE_BACKEND=d1`、绑定 `STATE_DB` 后，D1 保存登记、授权、邮箱关系、lastSeen、唤醒配置、Agent epoch、控制租约、调用关联和临时结果。`registry` / `host:<hostId>` scope 用复合主键隔离。授权读取使用主库；同一在线对象的事务先在实例内排队，避免多个 WebSocket、alarm 和 HTTP 请求争抢同一 scope 的版本。不同实例仍通过 scope 版本比较及原子 batch 提交保证一致性，冲突重试，耗尽返回 BACKPRESSURE，失败不回退旧授权。失败事务不阻塞后续请求。

HostRelayDO 保存在线 WebSocket、hibernation attachment、背压队列及调度。只有所有 Agent / CW / CC / 订阅连接关闭，HTTP、alarm、消息和转发均结束后，才在并发门内清空本地存储。D1 写入失败阻止清理；不依赖退出钩子导出。一个会话结束不能清空仍有其他连接的主机；空闲连接继续休眠。

RegistryDO 负责写入顺序和通知，迁移完成后删除旧业务副本，仅留防回退标记及真实到期 alarm。鉴权、主机 / 设备 / Key 列表和邮箱主机通过 Worker 访问 D1。Host 的控制版本只在内存缓存，提交后失效、休眠后重读，普通转发片段不逐条查询 fencing。既有五秒授权缓存、撤销及接收者校验保留。

HTTP 异步回执保持五分钟有效期，直接在 D1 按原凭据读取 / 确认，不为离线领取唤醒 DO。查询用一次 SQL 快照同时读取索引与分片，不因其他在线写入不断重试；确认删除仍经 CAS 事务，避免删除并发完成结果。结果分片原子保存；socket 断开不主动删除未到期 D1 调用记录，迟到结果受原 epoch / wire 校验。不因迁移重发业务，Agent SQLite 仍是完整历史及业务去重权威。

## 迁移与恢复

首次访问按 64 条一页复制旧 KV 并保存游标，全部完成后才提交 `@migrated`。失败保留旧数据，重试续传；完成的 scope 不重复导入。Host 全断开后回收本地数据，Registry 完成后回收旧业务副本。迁移后的 Registry 遇到 D1 缺失迁移标记或关闭模式会拒绝服务；须修复原绑定 / 恢复 D1，不能退回旧副本或直接发布不支持 D1 的版本。

启用前备份旧 DO 数据，之后另行备份 D1；保留 UUID 和部署证据。旧 DO 备份不能替代新的 D1 备份。管理员 `POST /api/v1/admin/state/migrate` 接受 `{after?: hostId}`，每页四个登记主机，含禁用和旧协议登记，返回 `{ids, after, done}`。失败重试同一游标；不接管会话或重启 Agent，在线对象等自然断开后清理。缺失 Registry 名称映射的 opaque 对象须另行核对，不能据此删除。

已迁移主机列表只读 D1 presence，不重复请求离线 DO。presence 仍是未确认的连接快照，异常断网尚未交付 close 时可能陈旧；主动 probe / 重连确认实际可达。

## 到期与配额

有限期 D1 记录和 `due:` 索引同事务写入。在线 alarm 每批四项，继续处理积压；永久授权 / epoch 不续期。全部断开后删除本地 alarm；Worker Cron 每小时第 17 分钟最多回收四个离线 scope、各两项索引，不调用 Host DO。事务再次检查无连接，删除回执分片 / wire；票据只释放匹配版本租约，保留 epoch。

过期记录立即失效，物理回收受积压影响，五分钟有效期不保证五分钟内删除。D1 有独立读写及空间配额，未验证生产节费。兼容日期 `2026-10-24` 满足 [deleteAll 同时删除 alarm 的要求](https://developers.cloudflare.com/changelog/post/2026-02-24-deleteall-deletes-alarms/)，提交遵循 [D1 batch 原子语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) 及 [平台限制](https://developers.cloudflare.com/d1/platform/limits/)。

## 本地与发布

先创建 `.dev.vars`，运行 `npm run dev:d1` 生成忽略目录内的本地配置、应用 schema，并共用 `.wrangler/state`。占位 UUID 仅供本地，不创建远程数据库。验证：

```bash
npx vitest run tests/d1-state.test.ts
npm run test:d1:migration
npm run test:e2e:d1
python3 tests/cloud-deploy.py
```

迁移测试使用真实 Wrangler，先建立旧模式授权和 epoch，再切换 D1，验证凭据、epoch 递增和结果跨断线 / 重启保留。完整端到端使用原生程序与 Chromium；旧系统依开发文档使用容器。

运维先创建专用数据库。全部必需 CI 作业成功后，用已校验 Worker 制品准备部署：

```bash
python3 scripts/deploy-cloud.py --commit HEAD --state-db-id DATABASE_UUID
```

该命令不发布。检查配置、制品和证据，获发布授权后加 `--apply`：先应用制品 schema，失败则不发布，再启用 binding / 模式 / Cron。**后续每次 D1 部署仍须传同一 `--state-db-id`**，直到生产源配置正式记录绑定；不要省略或切换数据库。

发布后在管理员登录的同源页面控制台分页迁移：

```js
let after;
for (;;) {
  const response = await fetch('/api/v1/admin/state/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ after }),
  });
  if (!response.ok) throw new Error(await response.text());
  const page = await response.json();
  console.log(page);
  if (page.done) break;
  after = page.after;
}
```

记录分页结果、暂缓清理的在线对象和 namespace 后续核查；本地通过或 `hasStoredData: false` 不证明生产对象已删除。
