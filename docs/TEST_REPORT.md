# 本机测试记录

## 单 Agent 多项目 · 2026-10-30（CI / 线上验收通过）

最终源码 `269859e32efe50e7809cbacb622eb7a2becfe01c` 的 [Actions 41022113021](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41022113021) 六项必需作业全部通过，包括完整旧功能/D1 浏览器回归、Windows、musl、Ubuntu 20.04 和 sanitizers。已通过核验后的 CI 制品配套部署 0.5.17 Relay/CW 和四平台下载，Worker `fcf72234-bf6e-4792-856b-619ce15e0ad3` 承接 100% 流量。线上健康、六项资源字节、五个归档 SHA256 和新增入口未授权拒绝检查通过。[发布证据](assets/multi-project-2026-10-30/deployment.json)。

首次发布提交 e56d55f 的 Actions 41019826408 中，regression 的新增项目端到端测试失败；部署未执行。已定位同一页面切换 `#manager` 时组件未监听 hashchange、依赖其他异步刷新偶然触发重绘的问题。修复后按请求 ID 隔离配对状态，测试显式等待页面空闲后进行片段导航，同时保存失败栈与截图供 CI 诊断；修正提交已完成全部必需 CI 并上线。

设计先行：[多项目设计](multi-project-design.md)。本次使用仓库现有 Bookworm 测试容器构建，构建目录 `.local/build-multi-project`；宿主机缺少 Boost 开发依赖，未使用本地构建作为发布制品。

- TypeScript、ESLint / Prettier、C++ 格式、协议生成和差异空白检查通过；16 个 Vitest 文件共 203 项通过。新增权限用例覆盖普通用户只读目录登记、跨 Agent 拒绝、平台管理、管理员邮箱覆盖/恢复、验证邮箱配对和管理凭证失效；签名 JWT 测试确认自报邮箱不能取得管理权限。
- CTest 的 `native-core` 和新增跨平台 `native-projects` 通过。覆盖空目录、原子登记与重启回执、版本冲突、ID 复用拒绝、路径别名/父子重叠、活动操作保护、目录失效和两个独立本地控制端点的认证。7 项原生登录/配置测试通过，包含不传 `--project` 的首次登录及已有配置兼容。
- `npm run test:projects` 通过：两个真实 Agent 进程、真实 coc-agent/coc-client 命令，检查动态添加、普通会话的移除保护、改名、幂等重试、通知、重启恢复、离线管理与取消注册不删文件。使用两个独立实例模拟用户工作区，未在本次本地验证中切换两个真实系统 UID；文件权限仍由系统执行。
- `npm run test:projects:e2e` 通过：临时 Wrangler、真实 Agent/CC、模拟 Codex 和 Chromium，完成管理员邮箱设置、网页添加/创建/浏览/改名、CC 浏览器管理身份配对、CC 添加及取消注册。1280 和 390 像素布局无页面错误或横向溢出。截图位于忽略目录 `.local/project-evidence/projects-desktop.png` 和 `projects-mobile.png`；测试身份、路径和 Worker 日志均留在 `.local/`，未访问生产状态。
- 网页构建通过，保留现有单包大于 500 kB 的构建提示。新增原生和端到端门禁已加入 CI；随后已推送修正提交并完成上述平台与完整回归 CI，按验证后的制品部署。没有模型调用，没有重启现有生产 Agent。

## CW 底部自动刷新与部署断流重试 · 2026-10-30（CI / 线上验收通过）

完整 Chromium UI 回归验证：程序滚动到底和向上手势不刷新；底部连续 20 次滚轮事件只同步一次并补回漏消息，手机连续触摸移动只同步一次；两者保留草稿及原控制连接。原有手动刷新及失效 OPEN 通道恢复继续通过。24 小时模拟空闲下 CW / 管理员周期请求均为 0，手动 probe 和撤销同步正常。TypeScript、ESLint / Prettier 与 9 项部署信任边界测试通过；部署故障注入覆盖文本响应部分输出被丢弃、Access Header、独立重试及文件续传。未调用模型。

最终源码 `97af93b2799bbfc6b617e6f964daa295000243d1` 的 [Actions 40999119690](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40999119690) 六项必需作业全部成功，包含完整旧 / D1 模式原生和 Chromium 回归、D1 激活 / 空闲归档 / 重启恢复。已通过核验后的 CI Worker / web 产物部署，健康版本 0.5.16、静态资源逐字节核验和 8 项公开 / 未授权入口检查通过。原生 0.5.16 归档保持原提交，线上四平台及源码包 SHA256 全部匹配。[发布证据](assets/agent-email-access-2026-10-30/deployment.json)。

## 0.5.16 · Agent 邮箱关联与网页更新通知 · 2026-10-30（已发布）

功能提交 `d67186a41e2419a06a1676e770c82c875be20c22` 的 [Actions 40994952207](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40994952207) 六项必需作业已全部成功，已使用核验摘要和来源的 CI 产物发布 Worker、网页及四平台下载。线上复验发现 health 仍硬编码 0.5.15，已改为读取包版本并增加回归；修正与底部刷新均在上述最终 CI 通过并上线，不重写已发布的 0.5.16 原生归档。生产未实际配置邮箱或发送更新通知，未重启 Agent。

- Bookworm 测试容器完成原生编译、CTest native-core 与 6 项真实登录 / 配置命令测试，无模型调用。邮箱共享样例由 C++ / Zod 同时校验，覆盖规范化、重复项、非法类型 / 格式及 20 个邮箱上限；本地命令验证清空、凭据保留和服务端失败不保存。
- 全量 Vitest 192 项通过，另追加 D1 原子撤销 / 重建和 Agent 握手撤销回归。服务端验证同邮箱跨浏览器自动访问、不同邮箱与访客隔离、Agent 不能配置别的主机、管理员覆盖 / 恢复、关联删除撤销、独立配对保留及显式撤销不因重连恢复。D1 故障注入确认配置 / grant / auth 一起回滚；握手回归确认只关闭被撤销 CW，保留其他连接及 Agent。
- 完整 Chromium UI 回归覆盖发布清单身份拒绝、通知失败重试、发送禁用和准确提交的 version / commit，以及邮箱输入校验、保存 / 清空 / 恢复、管理表格排序及桌面 / 手机布局。使用合成身份与主机，截图：[更新通知](assets/agent-email-access-2026-10-30/admin-agent-updates.png)、[邮箱关联](assets/agent-email-access-2026-10-30/admin-agent-email-access.png)、[桌面](assets/agent-email-access-2026-10-30/admin-table-emails-1280.png)、[手机](assets/agent-email-access-2026-10-30/admin-table-emails-390.png)。
- TypeScript、ESLint / Prettier、C++ 格式、协议生成一致性和差异空白检查通过。网页构建保留既有单包大于 500 kB 的提示。本地检查不代替同一提交的全部必需 GitHub Actions；实际 CI、部署身份与线上验收另行记录。

## CW 预览、修订同步与后台自动批准（功能 CI 通过，0.5.15 发布复验中）

新增文档预览下载、图片 / 音视频展开、丢失工具完成事件后按游标补齐、展开输出修订更新及关闭 CW 后原生 Agent 自动批准的回归。最终源码 `3bd75854c5e09967b18e8b8eff8924cbf28f7fcf` 的 [Actions 40886237129](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40886237129) 六项必需作业全部成功，Release 按分支规则跳过。本地 188 项 Vitest、原生核心测试及完整 Chromium UI / IndexedDB 缓存测试通过；CI 另通过两种存储模式的原生 / Chromium E2E，验证真实 Agent 在关闭 CW 后继续审批、重开恢复及关闭开关。尚未部署本次功能，新后台设置和传输水位需要升级 Agent / CC。0.5.15 的首次发布验证在 D1 空闲归档测试遇到只读观察器 `database is locked`；增加仅针对 SQLite 锁的有界等待，最终发布仍须新提交完整 CI 通过。[验收记录及截图](assets/cw-features-2026-10-29/ci.json)。

## 活动 DO / 空闲 D1 分层 · 2026-10-29（CI 通过，已部署）

本地 175 项单元测试通过；20 个并发控制与对象重建的同夹具对比，旧提交 `b7ef5b7` 准备 569 条主机 D1 SQL，新实现为 0，结果完整恢复。该计数不包含生产授权开销，不代表网络时延或生产费用。新增真实空闲归档 / 重启 / 再激活测试、失败恢复与回执取消测试均已写入仓库，最终源码 `fc89396aedee08eea8110376b5e206a9d72155e1` 的 [Actions 40866589978](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40866589978) 已完成，regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功。新增快照竞争及并发门故障回归也在该运行通过。旧 / D1 模式的完整原生 / Chromium 回归、真实空闲归档与重启再激活均成功；下载的 D1 验收制品已核对 SHA256，确认 epoch 1 → 2 → 3、归档发布、重启结果保留和离线确认不复活。分支 publish-release 按预期跳过；随后通过已校验 CI 制品部署，Worker `b7d06f6b-387d-49b3-866f-b84a227c446d` 接收 100% 流量。发布前 D1 快照完整性、发布后健康 / 资源字节及 13 项公开入口隔离检查通过；未重启 Agent 或重发任务，真实 CW 与长期稳定性未验收。[部署证据](assets/d1-active-session-2026-10-29/deployment.json)。[CI 与验收制品证据](assets/d1-active-session-2026-10-29/ci.json)。详见[方案评估](d1-active-session-review.md)。

## D1 握手争用修复发布验收 · 2026-10-29

`b7ef5b7` 的 [Actions 40852785403](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40852785403) 六项必需检查全部成功，已使用摘要与来源核验的 CI Worker / web 产物部署。Worker `9b64f656-5d4a-4269-b28e-c30cde5cb4f4` 接收 100% 流量，健康、线上资源字节及 13 项公开入口 / 未授权 HTTP 与 WebSocket 检查通过。补充探测最初使用了不存在的设备路由、且未带 WS Upgrade，分别返回 404 / 426；按源码路由和握手格式修正后全部通过。保留原 D1 绑定和下载包，无待执行迁移；未重启 Agent、执行模型任务或验收真实登录 CW 长期连接。[部署证据](assets/d1-handshake-2026-10-29/deployment.json)。

## D1 在线并发故障回归 · 2026-10-29

完整修复 `a744e71` 的六项必需 CI 全部通过并已部署；155 项 Vitest、内存临时数据库 D1 完整端到端 38 项、类型 / lint 通过。发布后健康与资源匹配、13 项公开入口及隔离检查通过，现有 Agent 只读查询成功。用户确认修复版浏览器仍不稳定。后续增加在线确认路由、原子 wire 替换、失败不丢映射、通知序号跨休眠递增和到期索引无需重写回归，159 项单元测试通过；原任务执行结果未确认。详见 [发布记录](DEPLOYMENT_STATUS.md)。

生产部署 `76dde28` 后，用户报告 CW 无法重连、`BACKPRESSURE` 与握手未确认。24 个同实例并发状态递增的内存 SQLite 测试在旧实现稳定失败，触发相同的八次 CAS 重试耗尽。实例内事务队列修复后 154 项 Vitest 通过，保留不同实例竞争测试，并验证失败事务后续仍可写入。随后增加持续修改 scope 版本时的回执查询回归，查询改为单次 SQL 快照，领取删除保留 CAS。线上授权成功、Agent presence 在线及部分控制回执完成不能证明用户任务已确认，未重发任务或重启 Agent。

## D1 持久状态与在线 DO 分离 · 2026-10-29（本地未发布）

- 在 `8473348` 后的工作树实现 D1 模式。Vitest 覆盖真实内存 SQLite schema / SQL、scope 隔离、CAS 竞争、原子到期索引、失败续传、断开后清理、离线回执隔离、缓存提交失效、禁止旧授权回退及中断清理时保留防回退标记。Registry 旧模式回调不被串行队列阻塞的回归也纳入测试。
- `npm run typecheck`、`npm run lint`、153 项 Vitest、原生 CTest、7 项部署脚本测试及 Worker dry-run 通过。真实 Wrangler 迁移测试通过：先以旧 DO 模式建立授权和 epoch，再切换 D1，原凭据有效、epoch 递增，完成回执跨断线 / Worker 重启保留。
- D1 与旧 DO 两种模式的完整端到端各通过 38 项检查，包含配对、隔离、唤醒、并发附着、显式接管、重复提交、历史分片、原生 CLI、Chromium 流式输出及撤销。已授权设备撤销用例先展开新增折叠组，再按原授权 ID 操作。防回退标记清理的最终调整另以单元故障注入和真实迁移重启复验。
- 按用户要求，测试使用内存数据库：单元 SQLite 为 `:memory:`，真实集成在 Bookworm 容器用 `--tmpfs /tmp:rw,exec,size=1g,mode=1777`，Wrangler 与原生 SQLite 临时库驻留内存。原生测试程序在容器独立目录编译，使用既有 Chromium 缓存；未调用真实模型。磁盘版曾遇到本地 I/O 超时，开发时热更新也曾中断测试；切换 tmpfs 并固定源码后完成验证，未放宽生产超时。原生 CTest 因沙箱禁止 socket 首次失败，授权后原命令通过。
- 本机日志 / 截图在忽略目录：`.local/d1-e2e-memory-final.log`、`.local/legacy-e2e-memory-final.log`、`.local/d1-migration-memory-final.log`、`.local/screenshots-d1/`、`.local/screenshots-legacy/`。没有创建远程 D1、发布 Worker 或删除生产 DO；尚无此次提交的 CI 和 Cloudflare 长稳 / 配额 / 实际存储回收证据。配置、回收积压及恢复限制见 [迁移说明](d1-relay-state.md)。

## HostRelayDO 存储审查与空对象写入 · 2026-10-29（本地未发布）

- 只读清单得到 36 个 HostRelayDO，27 个有数据、9 个无数据；近 24 小时分别有 4 个 / 0 个观察到活动。另有 1 个 RegistryDO 有数据。窗口内 namespace 存储最大值分别为 598,016 / 36,864 字节，不能当作当前单对象大小。没有读取生产 KV 正文或执行删除。具体口径、生命周期审查及限制见 [审查记录](relay-storage-audit-2026-10-29.md)。
- 修复空存储迁移标记及无人连接通知 revision 的写入；新增 3 项回归，覆盖重建后的空对象、状态 / 通知 / 撤销不落盘，以及后续新票据仍索引并调度。全量 Vitest 11 文件 / 139 项、类型检查、ESLint / Prettier 及差异空白检查通过；保留之前的 CW / 管理页面修改。此轮未重复运行原生测试或浏览器回归，源码变更仅为 Host / 通用期限迁移逻辑，未部署到生产。

## CW 刷新恢复、邮箱及管理表格 · 2026-10-29（本地未发布）

- `npm test` 通过：CTest native-core 与 Vitest 11 文件 / 136 项；新增成功认证时间、分钟内限频、authHash / authHost 时间更新及撤销不得复活验证。邮箱回归确认派生凭据成功认证后聚合时间，撤销仍作用于全部相关浏览器。
- Bookworm / Chromium 合成 UI 回归验证顶部刷新补回漏消息、历史 WebSocket 保持 OPEN 却不响应时 15 秒后请求重连、正常刷新不重建控制连接且保留草稿。设备表覆盖按 Agent / CW/CC 分组、同邮箱关联两台 Agent、各列表头切换排序、时间正反排序、无记录、桌面 / 390px 布局。邮箱 / guest 浏览器回归验证双语登出文字后的邮箱，管理员分组展开流程和原有访客路径隔离。
- 排序后点击撤销确认请求携带原始授权 ID。`browser-demand.ts` 模拟 24 小时，CW / 管理员周期请求均为 0；漏通知时刷新和设备 / Key 撤销仍同步主机列表。类型检查、ESLint / Prettier、网页构建和差异空白检查通过；网页构建仍提示现有单包超过 500 kB。
- 截图：[Agent 桌面](assets/cw-management-2026-10-29/admin-table-authorized-1280.png)、[Agent 手机](assets/cw-management-2026-10-29/admin-table-authorized-390.png)、[CW/CC 桌面](assets/cw-management-2026-10-29/admin-group-client-1280.png)、[CW/CC 手机](assets/cw-management-2026-10-29/admin-group-client-390.png)、[邮箱登出](assets/cw-management-2026-10-29/email-sign-out.png)。
- 所有证据使用合成授权 / 会话；没有调用模型、部署 Worker、更新生产凭据或重启 Agent。本地检查不替代同一提交的 GitHub Actions 与实际发布验证。

## Worker Access 公钥获取根因 · 2026-10-29

- 浏览器身份接口确认管理员邮箱已通过 One-time PIN、账户一致且不是机器身份；Worker 返回 `(keys)`。在无生产绑定的 Cloudflare 临时预览中，`fetch(..., { redirect: error })` 真实抛出 `TypeError`，提示边缘仅支持 `follow / manual`。这确认了公钥获取的运行时兼容问题，不能归因于邮箱、AUD 或用户密码。
- 改为 `redirect: manual` 后，同一隔离预览成功从固定团队 JWKS 地址取得 HTTP 200 / JSON / 两把 RSA 公钥；继续显式拒绝非成功响应。没有部署此预览为生产 Worker，也没有接入生产 DO、用户凭据或模型任务。[运行时证据](assets/access-jwks-2026-10-29/runtime.json)。
- 新增失败阶段回归，覆盖网络异常、超时、HTTP 403 / 302、错误格式和未知密钥，并验证响应不暴露凭据 / 邮箱 / 底层异常；默认 JWKS 测试要求 `manual` 模式。本地 Vitest 11 文件 / 122 项、类型检查、ESLint、变更文件格式与差异空白检查通过。用户同时修改的 `wrangler.jsonc` 保留原样，其格式不计为本次变更通过。最终源码 `e717628` 的 [Actions 40805956178](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40805956178) 六项必要作业全部成功，分支 publish-release 正常跳过；[CI 记录](assets/access-jwks-2026-10-29/ci.json)。

- 用户手工更新 Worker 后确认网页入口恢复，但管理员仍需密钥；身份接口返回管理员邮箱且 `autoAdmin: true`。检查发现其本地 `dist/web` 为 `index-szkHxAEH.js`，不含 `/auth/email/admin`，手工发布同时上传了旧网页。已核验最终 CI 的 verified-web 摘要和来源，将 `dist/web` 恢复为包含自动登录的 `index-B2RpgwK1.js`，并按原发布记录逐包核对、保留 0.5.14 四平台与源码下载；旧网页保存在忽略目录备份。用户随后重新发布并确认管理员权限已恢复；此项为用户真实浏览器确认，不宣称完成自动化生产浏览器回放。[恢复证据](assets/access-jwks-2026-10-29/frontend-restore.json)。

## Access 应用 Cookie 兼容 · 2026-10-29（待部署验收）

- 用户反馈邮箱登录后仍收到 `ACCESS_REQUIRED`；浏览器身份接口刷新后能显示邮箱，Worker 配置的团队域名和 AUD 与边缘登录应用一致。不能据此认定具体 JWT 失败阶段。
- assertion 请求头缺失时改为验证唯一的 `CF_Authorization` 应用 Cookie，保留签名、issuer、AUD、到期和机器双字段校验；已有但无效的 assertion 不回退。错误仅增加固定阶段，不包含 Token、邮箱或底层异常。
- 本地 Vitest 11 文件 / 116 项通过，包含新增 Cookie 管理员登录、伪造签名 / 过期 / 错误 issuer / AUD / 重复 Cookie / 超长 Token 拒绝、请求头优先和机器邮箱不能提升权限；类型检查、ESLint / Prettier 与差异空白检查通过。尚未以此本地结果代替完整 Actions 或真实浏览器部署验收。
- 本机实时日志连接因网络失败，已保存日志接口拒绝当前凭据；携带项目共享 Token 的生产请求仍返回登录重定向，需要核对同一应用的 Service Auth 策略关联与所选 Token。没有修改生产授权、用户会话或关闭 JWT 校验。

## 0.5.14 实际部署 · 2026-10-29

- 源码 `25a6bc80dc35a2d01a4d940d21abddbcca7f737d` 的 [Actions 40710590901](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40710590901) 六项必要作业全部成功。通过仓库云端部署脚本核验并发布同源 Worker、网页和四平台下载包；Worker 版本 `ac25bf62-6f91-45fe-90fd-9189a49e0a6a`。
- 线上 health 0.5.14 / protocol 1 正常，网页资源、手册、清单和 SHA256SUMS 字节一致；四平台包及源码包重新下载后 SHA256 全部一致。未登录 hosts 401、跨域管理登录 403、首页 200 / CSP 正常。
- 保留 vars / secrets、DO 数据及现有 Agent 服务；未创建 GitHub Release、重启用户会话或调用模型。真实 Access 邮箱登录及长期稳定性未验收，保留原有 Access 配置不代表已启用边缘 Access。[部署状态](DEPLOYMENT_STATUS.md)及[摘要证据](assets/release-0.5.14/deployment.json)。

## Cloudflare Access、邮箱授权及管理员邮箱 · 2026-10-28（本地未发布）

- 实现项目共享 Token 的原生内置默认值与 Worker 双字段硬校验、JWT 验证、邮箱持久 A 授权、跨浏览器恢复、旧凭据迁移及管理员邮箱自动登录。按项目要求，入口 Token 明文保存在 `config/cloudflare-service-token.json`；实际 CoC Key / owner 密钥不进入源码。
- `npm test` 通过：CTest native-core 和 Vitest 11 文件 / 113 项，其中新增 8 项 Access / 邮箱授权测试覆盖签名 / issuer / audience / 到期拒绝、两个 Service Token 字段、机器伪造邮箱、跨邮箱 Cookie、两台离线 A 的恢复、首次领取、管理员邮箱 / 密钥、配置轮换、全浏览器撤销和旧授权迁移。
- 原生 HTTPS/WSS 的可信 CA、错误 CA、错误主机名、直连与 HTTP CONNECT 六组测试通过，校验共享字段到达 Relay 且不进入 CONNECT 请求。额外 native-access 测试通过：无网络代理时 TUI 使用 loopback 桥接，远程 WS 同时携带共享 Token 和短期票据，非可信 origin 无 Token，登录 HTML 被拒绝。
- 两个全新 Chromium 上下文恢复同一邮箱的 A 列表，无配对调用；管理员邮箱自动登录，其他邮箱输入管理员密钥后进入管理。 Bookworm 容器中重复通过并检查中文截图：[邮箱恢复列表](assets/cloudflare-access-2026-10-28/email-hosts.png)、[邮箱管理页](assets/cloudflare-access-2026-10-28/email-admin.png)。该 UI 测试使用合成身份；真实 JWT 与持久状态由 Worker / RegistryDO 单元测试验证，不声称已完成真实 Cloudflare 登录。
- 现有完整 UI 稳定性回归通过，覆盖语言、恢复、缓存隔离、文件下载、审批、模式切换、管理表格和分页历史。首次因已有截图文件不可写中止，改用新的 `.local/access-ui-regression/` 输出目录后通过。
- Agent 部署测试 8 项、云端产物测试 3 项、Access 运维工具测试 4 项、发布来源 / 四平台合成产物检查通过。Access 运维测试验证 HTTPS origin 限定、Header 经标准输入、禁止凭据重定向和 HTML 下载拒绝。
- TypeScript、ESLint / Prettier、clang-format、原生 / 网页构建、Worker dry-run 通过。逐值核对：用户提供文件与项目配置一致，两个原生二进制和 Worker 产物包含同一配置，网页静态资源不包含共享 Secret。
- 宿主完整 E2E 因 glibc 不足无法启动 workerd；改用独立源码副本、Bookworm 原生构建及已验证网页产物后，完整 E2E 通过（真实 Wrangler / Durable Objects、确定性 Codex peer、Chromium），覆盖原有配对、Key 角色 / 目标隔离、TUI、重连与运行任务保留、Web 历史、在线撤销等流程。容器未挂载生产配置 / 数据库，没有调用模型、更新线上策略、部署 Worker 或重启生产 Agent。
- 本地验证不能替代同一提交的完整 Actions，尚无本次源码的 CI / Windows / musl 发布验证或实际 Cloudflare 边缘联调。上线仍需配置正确的 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ADMIN_EMAIL`，并验证 Token Header 转发和策略覆盖。

## CW 发送状态与模型选择 · 2026-10-28

- 功能提交 `f9d758b46b83d0ede0d5d28595d8b1de3e4cc720` 的 [GitHub Actions 40661577555](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40661577555) 已完成且成功。逐项核对 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部通过；分支 publish-release 正常跳过。[CI 记录](assets/cw-models-2026-10-28/ci.json)。后续文档记录提交不包含功能代码变更。
- `npm test` 通过：CTest `native-core` 及 Vitest 10 文件 / 105 项。共享 C++ / Zod 夹具覆盖 models 分页、prompt.model 正常值及空值 / 类型 / 空白 / 超长拒绝；原生指纹验证不同模型不能共享同一请求内容。
- `npm run typecheck`、`npm run lint`、`npm run lint:cpp`、`npm run protocol:check`、网页构建及 `git diff --check` 通过。
- Chromium 合成 UI 回归通过：发送立即提示、确认后等待回复、收到正文、完成后清除、RESULT_UNKNOWN 保留待确认、失败恢复草稿；`/model` 不产生任务、模型列表分页 / 隐藏过滤 / 错误重试、选择后请求携带 model、刷新恢复、执行中禁止切换，以及原有审批 / 重连 / 历史 / 语言回归。
- Bookworm 容器内 Chromium 再次完成 UI 回归；[手机模型面板](assets/cw-models-2026-10-28/cw-models-mobile.png)、[桌面模型面板](assets/cw-models-2026-10-28/cw-models-desktop.png)、[发送中](assets/cw-models-2026-10-28/cw-sending.png)、[收到回复](assets/cw-models-2026-10-28/cw-replying.png)。截图使用合成模型和对话数据，背景离线提示为票据重试夹具，非生产状态。
- 本机真实 Codex `initialize` + `model/list(limit=100, includeHidden=false)` 成功，返回 9 个模型，model / displayName 字段符合界面使用要求；没有调用模型、提交任务或操作已有会话。
- 本地完整 E2E 未计为通过：首次受网页重建触发的 Wrangler reload 打断，随后在旧设备申请超过五分钟后清理时失败。已将该审批恢复 / 清理夹具移到申请有效期内执行，保持产品过期规则；模型列表、模型传递、按模型去重及外部会话拒绝覆盖的集成断言已通过。
- 按项目约定停止本地完整回归，以本次功能提交的 GitHub Actions 结果验收，不把本地局部通过作为发行验证。尚未部署，模型选择需要网页、Worker 和 Agent 同时更新。

## CI 部署自动化 · 2026-10-28

- `python3 tests/agent-deploy.py` 八项测试通过：推送拒绝脏工作区 / 错误仓库、精确提交 / 工作流 / 六项必需作业门禁、artifact 摘要与归档穿越 / 链接拒绝、候选来源身份、未知 / 过期指标及忙碌工作不视为空闲、繁忙不停止服务、启动失败还原备份及旧版 curl 的中断续传重试。测试无网络、SSH 或系统服务修改；已纳入 Actions regression。
- 脚本真实准备模式已下载并校验上述运行的公开 musl artifact，核对 GitHub SHA256、包摘要与提交后通过 SSH 读取目标状态；目标仍有一个 runtime，准备模式未改动服务。初次发现 Ubuntu 20.04 curl 不支持 `--retry-all-errors`，已改为兼容的显式重试 / 续传并补回归。
- 自动化提交 `7c876a148adbad62ce7cb33973c2f6c663ce6cb7` 的 [Actions 40646225180](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40646225180) 五项构建 / sanitizer 成功，但最终 E2E 回归失败；部署脚本立即停止，未安装该运行产物。日志显示 Agent 重连后立即接管，测试只等待上游 WS OPEN，存在未完成 capabilities 协商就继续的竞态；补充权威主机 online 等待，最终结论以新 CI 为准。
- 原 CI 注释过长导致末尾断言被 GitHub 截断，现改为转义后保留最后 3500 字符；`python3 tests/ci-command.py` 验证大量日志下仍保留最后错误和原退出码，已加入 regression。
- 最终源码 `8ce86a1713cef6377d601bcc1cf0561ef220017e` 已通过脚本推送；[Actions 40647697874](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40647697874) 的 regression、sanitizers、Windows x64、musl、Ubuntu 20.04、Debian 12 六项检查全部成功，分支 publish-release 正常跳过。后续重复查询 GitHub API 返回 403，未完成该运行的新产物准备，不计为部署成功。
- 用户选择等待现有会话结束后安装。目标机心跳修复部署使用已核验的 `168ccf0` Actions 产物，脚本等待 runtime 及其他工作全部空闲；截至 2026-10-28 15:17（Asia/Shanghai）仍有运行会话，尚未替换或重启服务，不将 CI 成功记为目标机已升级。
- 2026-10-28 用户随后明确要求现在重启更新；15:43（Asia/Shanghai）在 `ubuntu-ThinkStation-P3-Tower-Gen-2` 安装 Actions 40644251548 的 `168ccf0` 心跳构建。GitHub API 复查返回 403，使用此前已核验的缓存运行 / 六项作业记录，并重新检查 ZIP SHA256 `b8fa9de52083c2a142ce9ea553262da85a1bf640e177f19da27b1e4f47162572`、包内摘要和构建来源。SSH 上传多次中断，最终 rsync 完成候选文件传输；实际备份 / 原子替换 / 重启 / 验证仍由 `scripts/deploy-agent-remote.py` 执行。
- 新服务 PID 5959 的实际运行文件返回 commit `168ccf0d57d2ffa866486dec0dabfc90e06b357b`、sourceDigest `65fa0a864e6d1ebe5d0e7b58c388979c7158f4e90f6e5708509704a1918f6478`、dirty false；连续 120 秒服务 active、PID 不变、已连接中继，无 Pong timeout / 重连耗尽，指标显示新 runtime 和业务事件。原版本备份名为 `coc-agent.backup-20261028T074309580171Z`。本机完整证据在忽略的 `.local/deploy-agent/40644251548/deployment.json`；未升级 CLI / Worker / 网页，未验证长期稳定性或真实账单。
- 心跳源码 `168ccf0d57d2ffa866486dec0dabfc90e06b357b` 的 [Actions 40644251548](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40644251548) 六项检查全部成功；分支发布作业正常跳过。部署脚本与项目规则后续提交需要独立等待 CI，不用前一次成功冒充新提交结果。

## Agent WebSocket 协议心跳 · 2026-10-28

- 真实原生 Agent 健康空闲 95 秒收到 3 个协议 Ping：零周期 JSON、零周期审批查询、零空闲重连；真实审批事件和业务 probe 成功。随后停止协议 Pong、持续发送 JSON pong，约 85.9 秒后自动重连并完成审批初始同步；Agent 进程保持运行，无模型调用。
- TLS / HTTP CONNECT 两种路径各等待 31 秒收到一个协议 Ping，正常连接未重建；不受信 CA / 错误主机名两种路径均拒绝。CTest 1 项、Vitest 10 文件 / 95 项、类型、ESLint / Prettier、C++ 格式与协议生成一致性通过。
- 本次仅 Agent 显式启用保活；CLI / 配对 / 本机 app-server 保持原行为。正常协议心跳不进入 HostRelay 业务 handler，不增加 Registry 查询或存储操作；重连仍有握手与鉴权用量。本地测试不能证明真实 Cloudflare 24 小时长稳或账单结果。
- 修复包按用户要求由 GitHub Actions 构建；运行与目标机安装验证另行记录，不以本机构建包冒充 CI 产物。

## 管理列表同步修复 · 2026-10-27

- 用户确认生产 `build-server` 在手动刷新后恢复一致；本次用户现象应归为管理页快照未同步，未证实该生产主机是旧协议记录。下述旧协议过滤是独立发现、已复现的问题，不能作为生产同名主机的根因结论。
- 定位管理操作后仅刷新设备 / Key 子列表，唤醒主机列表依赖通知补齐；通知丢失时本人的操作也可能留下不一致展示。统一本人操作、手动刷新和通知使用的管理快照读取，并等待读取完成。
- 扩展 `test:billing:web`：在模拟空闲 24 小时零轮询后，丢弃管理员所有订阅确认 / 变更通知，验证手动刷新恢复快照、撤销 Agent 及撤销 Agent Key 后设备 / Key / 唤醒主机列表一致。测试使用本机夹具 `build-server`，不访问或更改生产授权。
- 本地 Vitest 95 项、类型、lint、Worker dry-run 通过；上述 Chromium 回归通过，控制台错误为 0。宿主 Ubuntu 20.04 缺少可用浏览器，最终使用 Node 22 Bookworm 容器安装 Chromium 并执行；初始 IPC 权限 / 缺少浏览器及容器网络失败未计为通过。
- 源码 `ea659cf9f76afa97321f9f3aee60d15339f0e883` 已推送，[Actions 40435416363](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40435416363) 六个检查作业成功，含完整集成与新增浏览器场景，分支发布作业跳过。Worker `c92768d5-ac11-4c3b-9c79-15ad92499a7e` 于 `2026-10-27T02:02:33.382219Z` 部署，流量 100%；保留 vars / secrets、DO 数据和 0.5.12 原生下载。
- 线上 health 200、未授权 hosts 401、跨域登录 403、首页 CSP、HTML / JS / CSS / 手册及下载清单 / SHA256 字节与 UTF-8、五个归档 HEAD 通过。仅更新入口 HTML、新 JS 与手册；不登录生产管理、不改用户主机或凭证、无模型调用。[部署与验证范围](assets/admin-snapshot-fix-2026-10-27/deployment.json)、[线上字节与接口](assets/admin-snapshot-fix-2026-10-27/online-verification.json)。完整本机日志在 `.local/admin-snapshot-fix/`。

## 旧版主机列表过滤 · 2026-10-27

- 复现缺少 `version:2` 的历史主机 `build-server` 可出现在旧管理主机列表，但无对应新版已授权设备，且实际单主机读取 / 唤醒配置接口已拒绝访问。该测试名称为复现夹具，不代表已读取或确认生产同名记录的格式。
- 修复管理 `hosts` 返回与全局版本通知的协议过滤，保留历史存储及新版停用记录；验证旧主机不成为唤醒配置 / 授权目标或版本通知目标，新版主机正常保留，旧协议访问仍拒绝。
- Vitest 10 文件 / 95 项、TypeScript、ESLint / Prettier 与 Worker dry-run 打包通过。生产同名记录尚未通过管理员接口核对，不把复现结果当作生产记录已确认。
- 独立过滤修复 `165e500` 已推送，[Actions 40433028501](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40433028501) 成功；Worker `e7c72404-5706-436d-95f1-802fb9fdd029` 于 `2026-10-27T01:41:44.074548Z` 上线，流量 100%。保留生产配置、历史主机及原生包。公共 health / 401 / 403、手册字节和五个原生归档 HEAD 通过，但没有凭管理员身份核对生产主机。[部署证据](assets/admin-snapshot-fix-2026-10-27/legacy-filter-deployment.json)、[公共线上检查](assets/admin-snapshot-fix-2026-10-27/legacy-filter-online.json)。用户反馈已在上节单独澄清。

## 已部署：DO 实际用量与通知优化 · 2026-10-27

- 使用既有 Cloudflare OAuth 只读查询 namespace 归属、GraphQL schema 和两个完整 UTC 日 / 部署后小时数据；原始结果见 [daily](assets/do-usage-2026-10-27/daily.json)、[hourly](assets/do-usage-2026-10-27/hourly.json) 与 [范围记录](assets/do-usage-2026-10-27/metadata.json)。仅统计本项目两个 namespace，不混入同账户其他项目。
- Vitest 10 文件 / 94 项、TypeScript、ESLint / Prettier 和 Worker dry-run 打包通过，新增验证管理操作零 Host 通知、指定 / 未指定目标审批、到期通知隔离、改名 / 配置 / 撤销目标、全主机发布与重复发布幂等，以及迁移完成读取预算、重建与多页继续迁移。
- 源码 `08d0ff46606d4c74b3517e088af95f4b9cb72838` 已推送 master；[Actions 40431197988](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40431197988) 六个检查作业全部成功，包括完整 regression（真实 Wrangler / Chromium 集成）、sanitizers、Ubuntu / Debian / musl 和 Windows；分支发布作业按规则跳过。
- Worker `df318752-ee2e-4e23-9b43-3914baadf5cb` 于 `2026-10-27T01:17:29.296851Z` 上线，流量 100%，保留 vars / secrets，无新增 DO 迁移。沿用已发布的 0.5.12 五个归档、下载清单和 SHA256；部署前从同标签 GitHub Release 取得归档并与原线上 SHA256 逐一核对。初始本地 dist 下载是旧 0.5.8，未使用它部署；直连下载站超时的部分文件也未使用。Wrangler 确认仅上传更新后的手册，网页静态资源及原生归档复用原内容。
- 线上 health 200 / 0.5.12 / demand:1、未授权 hosts 401、跨域登录 403、首页 CSP、首页 / 下载清单 / SHA256 / 手册字节及 UTF-8 通过；五个归档部署后 HEAD 均为 200，未二次完整下载。未提交生产凭据、创建临时设备、操作既有会话或调用模型。初次沙箱部署因联网失败退出，随后联网重试成功。[部署与 CI 证据](assets/do-usage-2026-10-27/deployment.json)、[线上验证](assets/do-usage-2026-10-27/online-verification.json)，完整本机日志在忽略目录 `.local/do-optimization-deploy/`。本次优化后的实际线上节费和真实 24 小时受控场景尚未测量。
- 详细数据、推断与剩余观察项见 [DO 平台用量分析](do-usage-2026-10-27.md)。

## 0.5.12 Durable Objects 按需通讯 · 2026-10-26

- Agent 实际连续空闲 95 秒：应用帧、协议 ping、审批查询和空闲重连增量均为 0，跨过旧 90 秒阈值；真实审批通知及只读 probe 随后成功。CC 实测三轮查询，间隔 10.002 / 10.001 秒，只提交一次业务请求，退出后观察 10.5 秒无继续查询。
- Chromium 模拟 24 小时：CW 与管理员视图周期请求均为 0，手动刷新只触发一次 probe。另验证刷新保留草稿和当前控制连接，桌面 / 手机界面无溢出。模拟时间不代表真实 Cloudflare 24 小时运行。
- CTest 1 项、Vitest 9 文件 / 90 项、类型、ESLint / Prettier、C++ 格式和协议生成一致性通过。真实 Wrangler / 原生 Agent、CLI / Chromium 完整 E2E 通过，覆盖配对通知、角色与主机隔离、原生审批、接管 / 丢确认、历史、完整文件传输、慢读者及主动撤销。独立 UI / 唤醒、原生登录恢复、TLS / 代理、更新完整性 / 禁用 / 并发、备份恢复及发行来源保护通过；真实 Codex initialize / thread-start 与真实 TUI 通过新中继初始化也通过，无模型调用。
- 中间 E2E 因本机 glibc / libssl 不兼容改用 Bookworm 与匹配构建；首次验证期间重建站点触发 Wrangler reload 的中断未计为通过。后续发现并修复客户端“快照读取期间收到完成通知”的丢事件竞态；旧接管测试改为等待完整预留期限，审批失败恢复改由下一次真实请求事件触发。最终固定二进制与站点的完整回归通过。
- 独立 Cloudflare 测试 Worker 验证 A 离线时可订阅、202 控制领取和真实 A 往返；15 秒窗口未收到空闲通知。由于本机到 workers.dev 默认地址不可达，测试通过同一 Cloudflare edge 地址连接，保持原测试域名、Host / SNI 与 TLS 校验；没有使用生产凭据或主机。
- [本地验证](assets/billing-optimization-2026-10-26/local-verification.json)、[独立 namespace 冒烟](assets/billing-optimization-2026-10-26/stage-verification.json)、[CW 刷新](assets/billing-optimization-2026-10-26/cw-refresh-390.png)、[管理员刷新](assets/billing-optimization-2026-10-26/admin-refresh-390.png)。完整日志位于 `.local/billing-*.log`。发布身份与线上验证见下文。
- [Actions 40343777576](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40343777576) 的七个作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 与 publish-release。[v0.5.12](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.12) 的五个归档、下载清单及来源绑定功能提交 `3b41fce53a89707c281f7b27683369383fc620ea`；来源摘要 `151ca52aeaec2d3bcea2a63ab1cfe3a8cfe6b55c08228ba8cb08ed55031cff2a`。六个 Linux 程序在匹配环境启动并核对身份；Windows 运行由 Actions 验证。[发行校验](assets/billing-optimization-2026-10-26/package-verification.json)、[二进制](assets/billing-optimization-2026-10-26/binary-verification.json)。
- 干净构建额外通过 `tests/native-update.py --automatic --busy`：CLI 命令结束安装、空闲 Agent 安装并重启、忙碌时保留当前任务、停止后安装。独立测试 Worker 已删除；没有清理或操作生产用户主机。上线准备另修正在线手册中沿用旧版的每小时更新和 CW 三秒唤醒描述，保持已验证原生归档与标签不变。
- 生产 Worker `bb6a5e38-2851-4bcb-99b6-9619d43c9376` 于 `2026-10-26T15:08:13.284919Z` 发布至 `r.xlogic.cc`，流量 100%。功能源码为 `3b41fce`，在线手册修正来自 `c8b5972`；两者之间 Worker / 网页代码、协议与配置无差异。使用 `--keep-vars`，未轮换 OWNER_SECRET 或增加 DO 迁移。
- 线上 health 200 / 0.5.12 / demand:1、未授权 hosts 401、跨域管理登录 403、安全头及手册 UTF-8 通过。JS / CSS、清单、SHA256 和五个归档与 Actions 产物逐字节一致；在线手册与修正后的 docs/USER_GUIDE.md 一致，原归档及标签不改写。[手册修正来源](assets/billing-optimization-2026-10-26/manual-correction.json)、[线上字节](assets/billing-optimization-2026-10-26/online-verification.json)。
- 生产 Chromium 通过中英文切换、刷新保留、1280 / 390 菜单、管理员入口和无页面错误；浏览器未提交生产凭据。[浏览器记录](assets/billing-optimization-2026-10-26/browser-verification.json)、[手机](assets/billing-optimization-2026-10-26/production-english-390.png)。实际下载的 musl CLI 通过 HTTPS 更新检查，未替换程序；[TLS 验证](assets/billing-optimization-2026-10-26/musl-tls-verification.json)。
- 下载产物就绪后通过管理员 API 发布 `{version:0.5.12,commit:3b41fce…}` 通知，服务端就绪核对成功，发布专用管理会话已退出；没有创建生产设备或启动生产任务。[发布通知](assets/billing-optimization-2026-10-26/release-notification.json)、[部署身份](assets/billing-optimization-2026-10-26/deployment.json)。旧 Agent 在升级前仍有兼容心跳；部署没有直接替换远端用户服务。
- 未完成的平台验收：真实 24 小时 A / A–CW / A–CC、1 / 5 主机受控请求 / duration / SQLite 计量、跨网络静默断链和长期压力；不声称实际节费或这些长期门禁已通过。旧 Agent 的兼容心跳不计入新方案验收。

## 管理表格与 CW 会话自动批准 · 2026-10-26 · 已部署

- 待授权、已授权设备、唤醒配置和 API Key 改为原生表格，具有列 / 行标题、空状态及局部键盘 / 触摸横向滚动。1280 / 390 宽度验证长名称和留言、中英文表头、目标选择与锁定、页面无横向溢出。
- CW 显式勾选后自动允许当前会话的命令、文件和本轮额外权限；默认关闭，切换 / 刷新关闭。真实 Worker / DO / 原生 Agent / 原共享 app-server 夹具验证三类自动决定和权限 `scope: turn`；不改变后端策略或调用模型。
- UI 验证重复同步、反复开关、丢失 ack 后重连不重复提交；跳过已提交 / 未支持请求；关闭后停止自动答复。开关位于输入区，范围说明展开显示；390×480 审批详情与按钮仍可操作，展开说明不超出视口。
- 完整 `test:ui`、`tests/ui-wake.ts` 与 `test:e2e` 通过；TypeScript、ESLint / Prettier、网页构建和 Vitest 9 文件 / 86 项通过。早期测试发现独立开关栏压缩聊天面积，已移入输入区，保留原聊天几何断言。完整 E2E 在固定构建产物上重跑通过；未将并发覆盖构建目录造成的中间失败记为成功。
- [本地验证](assets/admin-tables-auto-approval-2026-10-26/local-verification.json)、[桌面管理表格](assets/admin-tables-auto-approval-2026-10-26/admin-table-pending-1280.png)、[手机表格](assets/admin-tables-auto-approval-2026-10-26/admin-table-keys-390.png)、[桌面自动批准](assets/admin-tables-auto-approval-2026-10-26/cw-auto-approval-desktop.png)、[手机自动批准](assets/admin-tables-auto-approval-2026-10-26/cw-auto-approval-390.png)。[Actions 40326037786](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40326037786) 的六个构建 / 回归作业全部通过，分支发布作业按预期跳过。
- 网页源码 `1d2f526bfa13d103a58ab4a2d3c269842fe978fe`，Worker `ec890616-6aa8-46f7-bfa7-bfe8029727e7` 于 `2026-10-26T13:02:48.210861Z` 部署，流量 100%。站点为从同一提交锁定依赖构建的本机产物，线上 JS / CSS / 手册与准备的产物逐字节相同；HTML 排除 Cloudflare 统计注入后匹配。原生五个归档及清单继续使用已验证的 v0.5.11，来源仍为 `59bb0de`，未改写标签或归档。
- 生产 health 200 / 0.5.11、未授权 hosts 401、跨域管理登录 403、安全头与手册 UTF-8 通过；Chromium 验证公开页面双语、刷新保留、桌面 / 手机菜单及管理员入口，无脚本错误。使用 `--keep-vars`，不轮换 secrets、不更改 DO 迁移或操作已有设备 / 会话，无真实模型调用；生产未提交凭据，实际审批行为由本地 / CI 夹具验证。
- [部署元数据](assets/admin-tables-auto-approval-2026-10-26/deployment.json)、[Actions](assets/admin-tables-auto-approval-2026-10-26/actions-verification.json)、[线上字节](assets/admin-tables-auto-approval-2026-10-26/online-verification.json)、[生产浏览器](assets/admin-tables-auto-approval-2026-10-26/browser-verification.json)、[预期站点身份](assets/admin-tables-auto-approval-2026-10-26/expected-site.json)。本机完整日志及校验脚本位于 `.local/admin-tables-deploy/`。

## Actions 构建缓存 · 2026-10-26 · 两轮远端验证通过

- Linux regression、Ubuntu / Debian 发行包、musl 和 sanitizers 启用按目标隔离的 ccache；musl 工具链通过 Buildx 的 GitHub Actions 后端缓存 Docker 层。构建失败后的缓存保存及命中统计独立于后续测试结果。
- 在 Alpine 3.23 / GCC 15.2 的隔离 CMake 夹具中验证：首次编译 0/2 命中，清理构建输出后重新编译 2/2 命中；修改版本头后 1/2 命中，实际程序输出由 `first:42` 更新为 `second:42`。证明复用编译结果不会保留过期版本头。详细日志位于 `/tmp/coc-ccache-smoke.log`；夹具只验证缓存机制，不代替项目测试。
- actionlint 1.7.12、Workflow 和变更文档的 Prettier、`git diff --check` 通过；[首次 Actions 40320593609](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40320593609) 六个构建 / 回归作业全部通过，分支发布作业按预期跳过；五份编译缓存及 musl 工具链缓存索引已通过 GitHub API 核实存在。编译缓存压缩归档总计约 84 MiB。[第二轮 Actions 40322209521](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40322209521) 六个构建 / 回归作业也全部通过，GitHub API 显示五份旧缓存的访问时间均已更新。观察到 regression 构建步骤 175→45 秒、Ubuntu 发行构建 / 测试 226→115 秒、Debian 206→113 秒、musl 工具链 58→22 秒、musl 构建 / 测试 328→146 秒、sanitizer 构建 208→46 秒。包含测试的步骤与纯构建分开记录，不将两次测量当作固定提速保证；[缓存证据](assets/ci-cache-2026-10-26/verification.json)。

## 0.5.11 正式发布与 musl 线上验证 · 2026-10-26

- 发布源码 `59bb0debfd2d7c7d34acb286a744be9820e0c187`，标签 `v0.5.11`；[Actions 40317904673](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40317904673) 七个作业全部通过：Ubuntu 20.04、Debian 12、Linux musl、Windows x64、sanitizers、完整 regression（含 E2E / UI）和发布。
- [GitHub Release v0.5.11](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.11) 提供四平台原生包、源码与站点包。核对站点 GitHub asset digest、五个归档 SHA256、清单身份及源码与该提交 `git archive` 完全一致。六个 Linux 程序均在匹配环境完成版本、来源及帮助命令检查；Windows 运行与打包由 Actions 验证。
- musl 归档为 24,743,413 字节。两个程序是静态 PIE，无 PT_INTERP 和 DT_NEEDED，可直接在 Ubuntu 20.04 宿主执行；CI 另在 Ubuntu 24.04 验证默认 musl 更新选择。线上实际 musl CLI 使用隔离空凭据配置成功完成 HTTPS 更新检查，返回 `Already up to date`，未替换程序。
- Worker `7fff05b9-5611-478d-8529-050295520b66` 于 UTC 11:59:04 上线，流量 100%，部署同一标签 Worker 和 Actions 站点。使用 `--keep-vars`，不轮换 secrets、不改变 DO 迁移、不创建授权或操作已有主机 / 会话，无真实模型调用。
- 线上 health 200 / 0.5.11，未授权 hosts 401，跨域管理员登录 403，安全头与手册 UTF-8 通过。所有 JS / CSS、手册、清单、SHA256 及五个归档与 CI 逐字节一致；HTML 排除 Cloudflare 统计脚本及标签间空白后相同。
- 生产 Chromium 验证中英文切换、刷新保留、1280 / 390 宽度菜单无溢出、管理员登录入口和无页面脚本错误；没有提交生产凭据。实际 Codex 模型任务、长期压力及硬件唤醒不属于本次验证。

永久证据：[部署](assets/release-0.5.11-2026-10-26/deployment.json)、[发行校验](assets/release-0.5.11-2026-10-26/package-verification.json)、[二进制](assets/release-0.5.11-2026-10-26/binary-verification.json)、[线上字节](assets/release-0.5.11-2026-10-26/online-verification.json)、[浏览器](assets/release-0.5.11-2026-10-26/browser-verification.json)、[musl TLS](assets/release-0.5.11-2026-10-26/musl-tls-verification.json)。本机完整下载、校验脚本和部署日志保存在 `.local/release-0.5.11/`。以下为发布前及历史记录。

## Linux musl 全静态构建 · 2026-10-26 · 本地验证，未发布

- 使用新增 `Dockerfile.musl` 的 Alpine 3.23 / GCC 15.2 工具链完成 Release 构建，静态链接 Boost.System、OpenSSL、SQLite、musl 和 C++ 运行库。实际产物为静态 PIE：没有 PT_INTERP 或 DT_NEEDED；允许用于自重定位的 PT_DYNAMIC。
- Alpine 内 CTest 1/1 通过（14.18 秒），`tests/native-login.py` 5 项通过（78.46 秒），不调用模型。
- 在 glibc 宿主直接运行两个程序的 `--version` / `--help` 成功；`tests/native-update.py --musl` 六组通过，以空 platform 配置验证默认选择 musl，覆盖 Agent / CLI 安装、SHA256、身份、协议、降级拒绝、关闭更新和互斥锁。
- `tests/release-provenance.py` 通过：拒绝非 ELF、动态加载器及无加载器但仍有 DT_NEEDED 的 ELF，接受静态 ELF / 静态 PIE，验证四平台组装、musl 身份和校验和拒绝。夹具平台归档为合成产物。
- 在 `.local/musl-release-check` 的隔离干净源码快照中重新生成构建身份并实际打包成功；musl 二进制归档及源码归档的 `SHA256SUMS` 全部校验通过，README 正确标明静态运行依赖。打包日志：`/tmp/coc-musl-package.log`。
- glibc 工具链配置 `COC_STATIC_MUSL=ON` 按预期拒绝；C++ 格式、变更文档 / workflow 的 Prettier 及 `git diff --check` 通过。日志位于 `/tmp/coc-musl-build.log`、`/tmp/coc-musl-update.log`；本轮尚未推送、运行远端 Actions 或发布。

## 0.5.10 · 2026-10-26 · Actions 发布与线上验收

- 测试修复提交 `4dae2e0`；发布源码 `ccc3a28347b045c90856ddbcb982ab0000c2008e`、标签 `v0.5.10` 已推送。[Actions 40313956429](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40313956429) 的 Ubuntu 20.04、Debian 12、Windows x64、ASan/UBSan、完整 regression 和发布作业全部通过，包含本轮英文 Tab 断言修复、Windows 中文配置、完整 E2E / UI。上次本机跨主机 `chat ready` 超时本轮及该次 CI 未复现，未以放宽超时处理。
- [GitHub Release v0.5.10](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.10) 提供三平台原生包、源码、校验和及站点包。下载后核对 GitHub site asset digest、下载清单 version / commit / sourceDigest / protocol、四个归档 SHA256 与独立 Release asset digest；源码归档与该提交的 `git archive` 字节一致，UTF-8 手册与源码一致。实际解包的四个 Linux 程序在兼容容器运行版本和帮助，构建身份相同且 dirty=false；Windows ZIP 的两个 EXE 为 PE x64，其运行测试由 Windows CI 完成。
- 使用同一提交的 Worker 与完整 CI 站点部署到 `r.xlogic.cc`，Worker 版本 `44ee79fc-ec0a-4f6e-98c5-5163e16a26ec`，UTC 11:25:48 上线，流量 100%。保留生产 secrets、vars、DO 数据与已有授权。线上 health 200 / 0.5.10、未授权 hosts 401、跨域管理员登录 403、安全响应头与手册 UTF-8 通过；JS / CSS、手册、清单、校验文件和四个归档与 CI 产物逐字节一致，首页及下载页排除 Cloudflare 自动注入的统计脚本与标签间空白后与构建一致。
- 生产 Chromium 通过中文初始页、English 切换与刷新保留、1280 / 390 像素菜单无横向溢出、管理员登录入口及无页面脚本错误；人工核对 [桌面](assets/release-0.5.10-2026-10-26/english-1280.png) / [手机](assets/release-0.5.10-2026-10-26/english-390.png) 截图。未提交生产登录或授权申请，未操作既有主机、会话或调用模型；管理员 Tab 及已授权会话行为由完整本地 / CI 回归验证。
- 永久证据：[部署与 CI](assets/release-0.5.10-2026-10-26/deployment.json)、[产物身份](assets/release-0.5.10-2026-10-26/package-verification.json)、[实际 Linux 二进制](assets/release-0.5.10-2026-10-26/binary-verification.json)、[线上字节核对](assets/release-0.5.10-2026-10-26/online-verification.json)、[浏览器](assets/release-0.5.10-2026-10-26/browser-verification.json)。本机脚本与详细日志位于 `.local/release-0.5.10/`；下文为发布前历史记录。

## 0.5.9 测试续修 · 2026-10-26 · 未发布

- 已核对提交 `1855bfa` 的 [Actions 40303440332](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40303440332)：Windows x64（含登录恢复与默认配置）、两个 Linux 平台及 sanitizers 全通过，regression 仍在 E2E / UI 组合步骤失败。没有获取该次完整 job 日志，不能断言与本机失败完全相同。
- 当前源码重新构建原生程序与网页后，在现有 Bookworm 测试镜像运行完整 `test:e2e` 通过，包含双 Cookie、跨主机新建会话、各标签页独立控制、审批、历史、文件、撤销与重连。上次 `chat ready` 超时本轮未复现，未放宽超时或宣称已找到其根因。
- 独立 `test:ui` 复现英文管理员登录后等待旧标题 `Device access management` 失败；实际界面为 `Pending access requests` Tab。更新标题断言，并检查英文待授权 / API Key Tab 与切换中文后的选中状态；完整 UI 回归重跑通过。
- E2E 失败时新增各页面截图与对话状态输出，单页截图最多等待五秒；CI 的 E2E / UI 命令使用现有 UTF-8 包装器输出错误注释，截图继续作为 browser-evidence 上传。
- 本机原生 Release 构建、网页构建、CTest 1/1、Vitest 9 文件 / 86 项、原生登录 5 项、TLS 六组、TypeScript、ESLint / Prettier、C++ 格式及协议生成一致性检查通过。日志保存在 `/tmp/coc-current-e2e.log`、`/tmp/coc-resume-ui-fixed.log` 与 `/tmp/coc-resume-*.log`，浏览器产物位于 `.local/resume-tests/`。无模型调用或生产操作；本轮改动尚未推送或在新 CI 上验证。

## 0.5.9 发布候选受阻与交接 · 2026-10-26

- 功能源码 `9002f52` 与 `v0.5.9` 已推送。Actions `40300123744` 的两个 Linux 平台和 sanitizers 通过；Windows 编译 / CTest 通过，但原生登录配置测试失败，regression 的完整 E2E / UI 步骤也失败，发布作业跳过。线上没有部署，仍为 0.5.8。
- 修复新增中文测试依赖系统默认编码的问题：配置读取、子进程捕获及 CI 日志输出显式使用 UTF-8。本地两项配置 / 登录测试和 ASCII 输出环境下的 CI 错误注释验证通过，Windows 修复结果尚待 CI。
- 本地完整 E2E 通过 CLI/TUI、历史、审批、管理员授权与 API Key 流程后，在 `tests/e2e.ts:1842` 跨主机新建网页会话等待 `chat ready` 超时；未解决、未宣称全部回归通过。用户要求保存进度，具体状态和恢复命令见 [发布交接](DEPLOYMENT_STATUS.md)。

## HTTP / SOCKS5 代理、实例显示名与管理 Tab · 2026-10-26 · 未部署

- `npm run build` 通过：Linux Release 原生程序、网页构建、TypeScript 和 Worker dry-run；没有发布。`npm run lint`、`npm run lint:cpp` 通过。
- `npm test` 通过：native-core 40.62 秒，全量 Vitest 9 个文件 / 86 项。原生代理夹具覆盖 HTTP CONNECT / SOCKS5、有无用户名密码、分片回复、HTTP / WebSocket、代理拒绝与握手超时、私网 / loopback / IPv6 本地地址绕过，以及 TUI 本机鉴权和双向转发。没有公网连接或模型调用。
- TUI 夹具复现关闭后服务器空闲计时器仍等待的问题，修复为显式取消 WebSocket 计时器；全部代理场景及完整 native-core 回归通过。远程地址覆盖省略默认端口、IPv6 和显式自定义端口。
- `npm run test:tls` 六组通过：HTTPS / WSS 在 loopback 时绕过配置的代理、公网测试 IP 经本地 HTTP CONNECT；可信证书通过，不可信 CA 与错误主机名均拒绝。测试仅用临时本地 CA 与服务端。
- `python3 tests/native-login.py LoginRecovery.test_generated_defaults_and_custom_configuration LoginRecovery.test_instance_settings_before_login` 通过：登录保存显示名与代理，保留原自定义设置；两程序登录前可保存、清除配置，拒绝非法代理且不改写已保存文件，Linux 文件权限为 0600。
- 名称接口验证只允许 agent / cli Bearer 修改自身名称；Agent 同步其主机名，CLI 不改变主机名。覆盖其他主机隔离、缺少身份、web 身份、撤销身份与无效输入。
- Chromium 在现有 Debian 开发容器内运行 `tests/ui-wake.ts` 通过：五个 Tab、方向键切换、仅展示选中面板、唤醒保存 / 禁用 / Agent 回退、390 像素手机无横向页面溢出，以及 CW 唤醒后的项目刷新。人工核对截图：[桌面](assets/proxy-names-tabs-2026-10-26/admin-desktop.png)、[手机](assets/proxy-names-tabs-2026-10-26/admin-mobile.png)、[CW](assets/proxy-names-tabs-2026-10-26/cw-online-mobile.png)。
- 本轮没有编译 Windows 二进制、运行完整 Wrangler E2E 或访问用户提供的生产会话；不把本地模拟验证视为生产恢复。代理与名称配置、兼容边界和已有会话 attach 方法见用户手册。

## 0.5.8 · 2026-10-26 · Actions 发布与线上验收

- 发布源码 `caca2b8`、标签 `v0.5.8`；[GitHub Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40261492201) 的常规回归、ASan/UBSan、Ubuntu 20.04、Debian 12、Windows x64 及发布作业全部通过，包含登录故障恢复、默认配置、端到端与浏览器回归。原生包与网页均取自该轮 Actions，没有在 WSL 交叉构建 Windows 包。
- [GitHub Release](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.8) 提供三个平台包、源码、校验和及完整站点包。组装时核对平台来源身份与归档校验和；下载站点包后核对 GitHub asset digest、源码身份及全部归档 SHA256。独立合成夹具验证损坏归档会被组装脚本拒绝。
- Worker `3925ec98-8742-4b73-bab4-dc97e71ceb16` 已部署至 `r.xlogic.cc`。线上健康接口 200 / 0.5.8、未授权主机列表 401；JS / CSS、UTF-8 手册、下载清单、校验文件及全部四个归档与 CI 产物逐字节一致。未操作生产用户设备或会话，未在生产调用模型。
- 首次本机解包使用了旧 Python 不支持的参数，后续部署命令仍继续执行，产生没有上传网页资源的中间 Worker 版本 `e3f9cb25-62e8-49a9-9b8a-287c8465c5ae`。修正解包后立即重新部署完整产物并通过上述验收；发布标签与 CI 归档未改写。后续校验与部署分步执行。
- Windows runner 验证原生程序与模拟协议；本次没有访问用户 Windows 上的真实 Codex 会话，不将 CI 结果视为已复现用户现场。远程审批仍须连接原客户端共享的 app-server。
- 永久证据：[发布身份与 CI](assets/release-0.5.8-2026-10-26/deployment.json)、[线上字节校验](assets/release-0.5.8-2026-10-26/online-verification.json)。下方“未部署”段落保留为发布前本机验证记录。

## 外部输出补全、Windows 审批诊断与配置默认值 · 2026-10-26 · 未部署

- Release 原生构建、CTest（包含外部输出补全与审批配置诊断）、全量 Vitest 84 项、TypeScript、ESLint / Prettier、C++ 格式检查通过。
- 外部输出夹具先让当前轮增加 40 项并刷新，再补全一个已移出最近 16 项窗口的旧消息，下一次同步仍收到完整内容；保持稳定条目去重与分页。
- `python3 tests/native-login.py` 全部四项通过：真实 Agent / CLI 网络失败恢复，拒绝 / 鉴权失败 / 到期停止，以及生成全部默认字段、保留已有自定义配置。Linux 自动更新默认开启，Windows 默认关闭由对应原生默认设置决定。
- `python3 tests/external-approvals.py` 在本机 Codex 0.164.0 与隔离模拟 Responses 服务上通过，远程拒绝不会执行命令，允许只执行无害 echo，原所有者保持连接。
- Windows 空审批 endpoint 的提示分支已加入 Windows 原生测试；本轮运行环境是 WSL / Linux，未编译或执行 Windows 二进制，未访问用户的 Windows Codex 服务、未部署或调用真实模型。

## 原生配对登录超时恢复 · 2026-10-26 · 未部署

- Release 原生构建、CTest（native-core）、Vitest 全量 84 项、TypeScript、ESLint / Prettier 和 C++ 格式检查通过。
- `python3 tests/native-login.py` 的三个用例分别运行通过：真实 Agent / CLI 连续遭遇连接中断、30 秒 HTTP 超时、批准响应丢失后，用同一请求和轮询秘密完成登录并保存凭证；拒绝、鉴权失败、原申请到期均停止且不保存凭证。夹具补充 CLI 登录后的主机查询响应后，CLI 恢复用例重跑通过。
- Relay 回归验证同一原生批准结果可重取但不重复签发，错误秘密、凭证撤销、目标 Agent 撤销和到期均拒绝；到期清理保留已领取凭证，撤销未领取批准结果；网页保持单次交付。新增原生回归已接入 Linux CI。
- 测试仅访问本机临时 HTTP 夹具，不访问线上、不调用模型；本轮未验证 Windows 二进制或线上网络超时的具体来源。

## 网页中英文与顶部滚轮加载 · 2026-10-25 · 上线验收

- 发布源码 `c74a06c` 已提交并推送至 master。Worker 版本 `3c3ad45a-6c5d-4fe2-9485-1ab550bcc1eb` 于 UTC 14:39:48 部署至 `r.xlogic.cc`，流量 100%，部署标签 `cw-i18n-c74a06c`。仅更新网页与在线手册，既有 0.5.7 原生包及源码归档不变。
- 健康检查 200、未授权业务 401、跨域管理登录 403 和静态安全响应头通过。线上 JS / CSS、UTF-8 在线手册、下载清单及校验文件与本地发布构建字节一致；首页除 Cloudflare 自动注入的统计脚本与空白外与构建一致。线上全部七个既有 0.5.6 / 0.5.7 下载归档 SHA256 校验通过。
- 线上真实 Chromium 验证中文 / English 即时切换、刷新保留、标题 / lang、同源标签页同步、英文管理员登录入口及桌面 / 手机短视口菜单，无脚本错误。未提交生产登录或授权请求，未操作已有主机和会话，未调用模型。截图位于本机 `/tmp/coc-release-english-1280.png` 与 `/tmp/coc-release-english-390.png`。
- 历史已在顶部时继续上滚加载、读取失败后重试、分页去重及阅读位置保持由发布前完整合成 API / WebSocket Chromium 回归验证；线上实际 JS / CSS 与已测构建核对，不将未登录浏览器检查宣称为真实用户会话验收。

## 网页中文 / English · 2026-10-25 · 本地验证

- 网页构建、原生 CTest、82 项 Vitest、TypeScript、完整 ESLint / Prettier、Chromium UI 回归及 Worker dry-run 通过；未调用模型。发布前既有下载包的 SHA256 全部通过，线上校验清单与本地一致。
- 浏览器验证即时切换、刷新保留语言、文档标题 / lang、缓存对话组件的工具标签更新、对话原文与草稿保留，以及切换时不增加 attach 请求。待确认审批的允许 / 拒绝按钮和分页状态随语言切换，连接保持。
- 英文文件面板、未登录授权、管理员登录、设备管理和 API Key 页面通过；1280×900 与 390×480 菜单的语言选择和模式切换按钮可见，无横向溢出。截图保存在本轮 `COC_ARTIFACT_DIR` 临时目录的 `cw-english-1280.png` 和 `cw-english-390.png`。
- 单元测试覆盖中英文界面文案、插值重排、含特殊字符的文件名、已有动态状态通知、未知错误原样保留，以及全表英文非空与插值完整性。

## CW 顶部滚轮加载修复 · 2026-10-25 · 本地验证

- 网页构建、TypeScript、受影响代码 ESLint / Prettier 和完整 Chromium UI 回归通过；未部署。
- 历史读取失败后，消息滚动条保持在顶部，真实向上滚轮可重试并加载下一页；向下滚轮事件不触发加载。分页阅读位置保持、请求去重、历史读完后停止加载及缓存回读检查通过。
- 默认截图目录存在写权限问题，改用临时目录保存本轮 UI 产物后回归通过。

日期：2026-10-25。0.5.6 已发布，源码标签 `v0.5.6` 指向 `672e5f42120bf1c527fee58b73313190f2d89be3`。最新部署和线上唤醒验收见下文，后文保留各版本历史证据。本轮未调用模型。

## 未发布 · Windows x64 支持

- 功能源码 `0c4a18e0501f019fe30c222eb0e3677aa2e8242c` 已推送到 `feat/windows-x64-20261025`。[GitHub Actions 40186032178](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40186032178) 于 2026-10-25 UTC 10:48:59 完成，`windows-x64`、`regression`、`sanitizers` 三个作业全部通过；[验证元数据](assets/windows-x64-2026-10-25/actions-verification.json) 保存源码、步骤结果与产物摘要。证据文档另行提交，不改写已构建源码。
- Windows Server 2022 / MSVC x64 / vcpkg 静态构建通过。原生 CTest 覆盖 UTF-8 凭据与受保护 ACL、配置/状态排他锁、SQLite 历史与去重、项目大小写重叠、非法路径与只读策略、文件上传/读回/完成去重/版本拒绝/覆盖/取消、目录句柄释放、参数引用、进程树终止、stdio RPC、Windows 根证书加载及异步 DNS / HTTP。符号链接测试仅在系统允许创建链接时执行。
- Agent / CLI 的 `--version`、`--help`、模拟 PE 的打包保护回归以及正式 ZIP 打包通过。Actions 的 `windows-x64` artifact 包含 `coc-0.5.6-windows-x64.zip`、源码归档、`SHA256SUMS` 与下载清单；ZIP 含两个 `.exe`、示例、手册和静态依赖许可证。打包核对干净源码、版本/提交/源码摘要/协议/目标，并拒绝错误平台、脏源码和陈旧程序。此为分支预览产物，尚未更新生产下载页。
- vcpkg 二进制依赖与工具/源码下载分别缓存，失败构建也保存缓存；依赖变化时按 ABI 复用兼容包。观察到依赖配置从未配置二进制缓存时的 406 秒降为命中后的 47 秒；这是依赖准备阶段的实测，主程序仍重新编译。
- Linux Release、原生 CTest、77 项 Vitest、TypeScript、ESLint / Prettier、C++ 格式、协议文档、网页/Worker dry-run、TLS、备份、发布来源、实际自动更新、Chromium 端到端/界面回归及 sanitizer 全部通过。C++ 测试同时兼容 clang-format 10 / 18；Windows 聊天路径覆盖盘符、反斜杠、file URI、行号、大小写及越界拒绝。
- 本地 Windows 构建已按用户要求停止，Windows 主程序编译/测试/打包均以 Actions 结果为准。本机旧 Codex 0.130.0 未升级或用于会话验收；未调用模型、未部署生产。真实 Windows Codex 0.164.0 TUI、沙箱设置、重启/休眠与长期压力仍待验收；Windows 当前采用手动整包升级。

## 网页更新 · 2026-10-25 · CW 刷新恢复会话上线验收

- 功能源码 `9bf7f4b` 已提交并推送；Worker 版本 `fe350e29-82eb-49f3-82f2-1cea3090b10b` 于 UTC 03:46:28 部署至 `r.xlogic.cc`，流量 100%。网页和在线手册同步更新，原生程序与源码下载继续保留既有 0.5.6。
- 发布前网页构建、类型、ESLint / Prettier、76 项 Vitest、完整 Chromium 界面回归及 Worker dry-run 通过。线上健康 200、未授权业务 401、跨域管理登录 403、安全响应头、JS / CSS 与 UTF-8 手册字节一致性，以及两个平台原生包和源码归档 SHA256 全部通过。
- 真实 Chromium、实际下载的 0.5.6 Agent、独立临时项目和确定性 Codex 夹具通过生产中继验收：刷新后自动恢复相同主机、项目、会话 ID、历史和草稿，不打开选择弹窗、不新建会话；停止临时 Agent 后再次刷新，自动恢复原会话缓存和草稿，显示离线只读状态且禁止发送。
- 桌面 / 手机聊天文件下载回归通过，六次 300003 字节二进制内容完全一致，空文件、缺失文件错误、项目范围与固定版本读取正常。浏览器无脚本错误，Cookie 保持 HttpOnly / Secure。全程未调用模型，未操作用户已有设备；临时请求与授权已撤销，临时 Agent 停止，管理会话已退出。
- 永久证据：[部署身份](assets/workspace-restore-2026-10-25/deployment.json)、[线上资源和发行归档](assets/workspace-restore-2026-10-25/online-verification.json)、[实际浏览器交互](assets/workspace-restore-2026-10-25/browser-verification.json)、[刷新恢复](assets/workspace-restore-2026-10-25/production-restored-session.png)、[离线刷新恢复](assets/workspace-restore-2026-10-25/production-restored-offline.png)。截图布局已检查，宿主缺少中文字体，中文为方框；原始脚本及日志位于忽略的 `.local/workspace-restore-release/`。发布证据单独提交，不改写已部署功能源码。

## 发布前 · 2026-10-25 · CW 刷新恢复会话

- 网页构建、TypeScript、ESLint / Prettier 与 76 项 Vitest 通过。新增单元回归覆盖非默认项目、最新会话状态优先、目录最新页之外的会话快照、无打开会话的项目选择、跨主机 / 项目 / 模式及损坏快照拒绝、浏览器存储不可用降级。
- Chromium `test:ui` 完整回归通过。刷新后无需手动选择即可恢复主机、会话、草稿和待确认任务，未重复提交任务；离线自动恢复缓存；非默认第二项目的会话及独立草稿自动恢复。本地目录记录缺失时，结合服务器目录和保存的会话元数据仍能恢复；已移除项目回退到可用项目，更换身份不复用旧会话和草稿，伪造未授权主机提示被清除。
- 原有桌面 / 手机下载、二进制完整性、长历史、审批、模式切换、重连和分页缓存回归通过。未调用模型或部署；只调整网页状态持久化，不修改 Agent / Worker 协议、授权与控制权规则。[刷新恢复截图](assets/workspace-restore-2026-10-25/cw-restored-session.png) 已检查布局；宿主缺少中文字体，截图中文为方框。原始截图位于 `/tmp/coc-workspace-restore-ui/`。

## 网页更新 · 2026-10-25 · CW 聊天路径下载上线验收

- 源码 `3856260` 已提交并推送，Worker 版本 `60d4a34d-5b75-46ce-93b9-a343d99090a8` 于 UTC 03:30:33 部署至 `r.xlogic.cc`，流量 100%。网页及在线手册同步更新；原生程序及源码归档继续提供既有 0.5.6，无需升级 Agent / CLI。
- 发布前类型、ESLint / Prettier、70 项 Vitest、网页构建、完整 Chromium 界面回归及 Worker dry-run 通过。线上健康 200、未授权业务 401、跨域管理登录 403、安全响应头、JS / CSS / 在线 UTF-8 手册字节和全部归档 SHA256 核对通过。
- 真实 Chromium、实际下载的 0.5.6 原生 Agent、独立临时项目及确定性 Codex 夹具通过生产中继验证：桌面 1280×900 和手机 390×844，分别单击带行号的绝对 Markdown 文件链接、行内代码文件名、正文相对路径，共六次下载，每次 300003 字节与原始二进制完全一致。空文件、缺失文件错误、项目 ID / 相对路径隔离、后续块版本固定、外部 HTTPS 链接、刷新后从会话记录重新进入及 HttpOnly / Secure Cookie 均通过，浏览器无脚本错误。
- 仅使用临时测试主机和项目，未调用模型或操作已有用户设备。临时授权、待处理请求、Agent 进程及管理会话均已清理。首次脚本误以为刷新会自动打开原对话，修正为通过会话记录重新选择后完整验收通过，产品代码未改变。
- 永久证据：[部署身份](assets/chat-download-release-2026-10-25/deployment.json)、[线上资源与归档](assets/chat-download-release-2026-10-25/online-verification.json)、[实际下载交互](assets/chat-download-release-2026-10-25/browser-verification.json)、[桌面截图](assets/chat-download-release-2026-10-25/production-chat-download-1280.png)、[手机截图](assets/chat-download-release-2026-10-25/production-chat-download-390.png)。宿主缺少中文字体，截图中文为方框，只验收布局与交互。脚本和原始日志位于忽略的 `.local/chat-download-release/`；发布证据单独提交，不改写已部署源码。

## 发布前 · 2026-10-25 · CW 聊天路径下载

- 网页构建、TypeScript、ESLint / Prettier 及 70 项 Vitest 通过。新增测试覆盖项目内路径解析、URI 编码、行号定位、项目外与越界拒绝、Markdown / 代码 / 用户消息渲染、超长连续正文、分块二进制完整性和文件版本变化终止下载。
- Chromium `test:ui` 完整回归通过，新增桌面 1280×900 与手机 390×844 的实际浏览器下载，检查文件名、全部二进制字节、项目 ID 和后续块固定版本；缺失文件显示失败，项目外路径不生成下载链接，普通 HTTPS 链接保持原地址。原有长历史、分页缓存、审批、重连和模式切换回归通过。
- 本地截图位于 `/tmp/coc-chat-download-ui/chat-download-1280.png` 和 `chat-download-390.png`；已检查布局。宿主浏览器缺少中文字体，截图中文显示为方框，不作为中文字体渲染验收。本轮未调用模型、未发布部署，未修改 Agent / Worker 协议或服务端文件权限。
- 首次完整界面回归发现超长无分隔文本的路径正则匹配耗时过长；先跳过不含路径分隔符或扩展名的文本片段后通过，新增长正文回归。已有 `.local/ui-stability` 截图文件不可写，改用上述临时目录。

## 0.5.6 · 2026-10-25 · 发布与线上验收

- 源码 `672e5f4` 和标签 `v0.5.6` 已推送。Worker 版本 `cf6537ae-7597-485b-ad9f-6ff5ce39032a` 于 UTC 02:41:49 发布至 `r.xlogic.cc`，流量 100%；Worker、网页、在线手册和两平台原生下载同步更新。
- Ubuntu 20.04 / Debian 12 干净 Release 构建、两平台 CTest、63 项 Vitest、TLS 的可信证书 / 未知 CA / 错误主机名、原生与 Chromium 唤醒回归、类型 / 格式 / 协议检查、发行来源与 Worker dry-run 均通过。干净构建的更新器回归包括 CLI 自动安装、空闲 Agent 关闭存储后重启；未直接替换其他用户主机服务。
- 两平台归档中的程序逐字节等于已验证构建，版本 / 提交 / protocol / sourceDigest `b5b12c3d8f33e3de095ca77d0429a7976621994c471d18e26c22ac362e95f0db` 一致且 dirty=false；源码归档等于 `git archive`，所有 SHA256 匹配。实际从生产下载的两个平台程序在匹配环境执行 `--version / help` 通过。
- 线上健康检查报告 0.5.6，网页 JS / CSS、手册、下载清单和三个归档均与本地字节 / SHA256 一致；未登录业务 401、跨域管理登录 403、安全响应头及手册 UTF-8 通过。
- 使用实际下载的 Ubuntu 程序、真实 Chromium 和独立临时主机验证：Agent 命令配置 URL；管理员离线覆盖 / 禁用 / 恢复 Agent 地址；CC `status` 触发实际 GET 并收到 requested，随后请求受到 cooldown 限流；CW 发现离线自动请求唤醒，CC `projects` 等待 Agent 启动后恢复，CW 自动加载项目，在线唤醒返回 online；普通列表不暴露 URL，错误角色 / 目标调用拒绝，Cookie 保持 HttpOnly / Secure，浏览器无脚本错误。
- 生产唤醒 GET 使用 `https://example.com/` 这一无副作用的测试地址，随后手动启动临时 Agent 验证恢复；未测试真实硬件休眠 / 开机，不把 HTTP 成功等同于开机完成。本地完整端到端则由独立唤醒服务实际启动 Agent。全程未调用模型，只撤销本次带测试前缀的临时请求 / 凭据，测试 Agent 已停止、管理会话已退出。
- 首次线上验收脚本错过登录后立即发出的唤醒响应；提前注册监听后，又因提示框含“关闭”按钮而不满足整段精确匹配。调整测试监听与文字断言后完整线上唤醒验收通过，产品代码未改变。
- 永久证据：[部署身份](assets/wake-release-2026-10-25/deployment.json)、[发行包校验](assets/wake-release-2026-10-25/package-verification.json)、[线上资源](assets/wake-release-2026-10-25/online-verification.json)、[线上唤醒交互](assets/wake-release-2026-10-25/browser-verification.json)。本地日志位于 `.local/wake-release-0.5.6/`；发布后证据单独提交，不改写已发布的源码标签或发行归档。

## 0.5.6 · 2026-10-25 · 离线 Agent 唤醒（发布前验收）

- 宿主原生 / 网页构建、CTest 1/1、63 项 Vitest、类型、ESLint / Prettier / clang-format 和协议文档检查通过；Worker dry-run 打包通过，仅打包未发布。共享 URL 夹具验证 C++ / Zod 的支持范围。
- 配置与唤醒单元回归覆盖主机和角色隔离、URL 脱敏、管理员覆盖 / 禁用 / 恢复、在线跳过、并发只访问一次、DO 重建保留限流、失败 / 重定向 / 网络异常限流以及撤销后禁止唤醒。
- 真实原生程序配合本地 HTTP / WebSocket 夹具验证 Agent 配置命令、清除和 capabilities 登记，以及 CC 唤醒等待、相同幂等标识的离线重试、`status / hosts` 触发和未配置的错误。Chromium 验证管理员保存 / 禁用 / 恢复、手机布局和 CW 自动唤醒后加载项目；原有完整 `test:ui` 回归通过。
- 完整真实 Wrangler / 原生程序 / Chromium 端到端回归通过，包含新增场景：Agent 停止时由原生 CC 发现离线并发起请求，中继 GET 独立本地唤醒服务，服务启动原生 Agent，CC 等到上线后成功读取项目；唤醒请求不携带中继凭据，在线跳过且普通列表不暴露 URL。测试使用临时凭据和确定性 Codex，不调用模型。
- 宿主 Wrangler 启动报 EPIPE，使用现有 Bookworm release 测试镜像、关闭外部网络继续验证；旧 local 镜像缺少 git，未修改系统或安装依赖。截图由包含中文字体的容器生成并目视检查：[管理员桌面](assets/wake-url-2026-10-25/admin-desktop.png)、[管理员手机](assets/wake-url-2026-10-25/admin-mobile.png)、[CW 上线后目录](assets/wake-url-2026-10-25/cw-online-mobile.png)。未部署。

## 0.5.5 · 2026-10-25 · 发布与线上验收

- 发布源码 `8da4085` 和标签 `v0.5.5` 已推送到 GitHub。Worker 版本 `58969fbd-0d20-4bb8-adf7-e52aa68dc53b` 于 UTC 02:18:34 部署到 `r.xlogic.cc`，流量 100%。网页、Worker、在线手册及 Ubuntu 20.04 / Debian 12 原生包同步发布；保留生产密钥、已有授权、配置与 DO 数据。
- 两个平台干净构建、CTest、56 项 Vitest、TLS、类型 / 格式 / 协议检查及发行来源门禁通过；自动安装、空闲 Agent 关闭存储后重启通过。完整 Wrangler / 原生程序 / Chromium 端到端及桌面 / 手机界面回归通过，覆盖启动和运行审批提示、去重、503 恢复、角色 / 主机隔离、历史 / 文件 / 撤销 / 重连。TLS 与同名 CW 撤销夹具修正见发布前记录。
- 两平台四个程序的版本、提交、协议及源码摘要一致且 dirty=false；归档中的程序字节等于对应已验证构建，源码归档等于该提交的 `git archive`，三个归档 SHA256 一致。线上首页资产引用、JS/CSS、UTF-8 手册、下载清单和全部归档与本地一致；健康 200、未登录业务 401、跨域管理登录 403、安全响应头通过。线上实际下载的 Debian 程序在匹配容器执行版本与帮助通过。
- UTC 02:20:27，真实 Chromium 和线上实际下载的 Ubuntu Agent/CC 完成生产交互验证：临时 A 原生登录；CC 指定目标申请先保持待审批，Agent 启动输出该申请及人工命令，再由原生 `approve` 批准；CW 指定目标后 Agent 运行中输出提示并明确批准，HttpOnly / Secure Cookie 刷新保留；原生 `reject` 拒绝另一 CW，未签发浏览器凭证。
- 管理员改绑目标、Agent 批准未指定目标、CC / CW 越权审批或管理、跨主机访问均被拒绝；CC 撤销后返回 401。浏览器无脚本错误，临时申请、授权和管理会话已清理，测试 Agent 已停止。没有操作用户原有设备、项目或调用模型；线上仅验证审批与连接，真实模型任务和长期负载不在本轮验收范围。已有服务器按原自动更新设置升级，未直接替换其他主机服务。
- 永久证据：[部署身份](assets/agent-approval-release-2026-10-25/deployment.json)、[包校验](assets/agent-approval-release-2026-10-25/package-verification.json)、[线上资源](assets/agent-approval-release-2026-10-25/online-verification.json)、[审批交互](assets/agent-approval-release-2026-10-25/browser-verification.json)。详细日志与截图 `.local/agent-release-0.5.5/`。发布后的证据单独提交，不改写发布标签或发行归档。

## 0.5.5 · 2026-10-25 · Agent 审批与运行提示（发布前验收）

- CC 使用 `login --host A_ID`、CW 选填目标服务器 ID 发起明确目标申请；Agent 的 `requests / approve / reject` 仅处理自己的客户端申请。未指定目标继续由管理员选择；已有凭证和 API Key 登录兼容。
- 原生与网页构建、CTest 1/1、六文件 56 项 Vitest、类型 / ESLint / Prettier / clang-format 检查通过。新单元场景覆盖 cli / web 作用域、列表脱敏、目标不可改绑、伪造审批身份、错误角色、到期与拒绝、在途撤销、API Key 撤销和并发审批只签发一次。
- Chromium 桌面 / 手机 `test:ui` 通过，包含完整历史窗口、本地缓存重复阅读、草稿、菜单和审批布局回归。
- 0.5.5 发布门禁补充：TLS 夹具原先把全部 HTTPS 请求认作 CC，新增 Agent 启动查询使该断言失败。夹具现按路径校验角色凭证，并等待 Agent 查询与 WSS 同时完成；可信证书通过、未知 CA 与主机名不匹配拒绝三项均通过，产品 TLS 策略保持。 新增定向 CW 夹具使用独立设备名，避免旧撤销场景按默认名称匹配到已关闭的另一浏览器授权。
- Agent 运行提示追加回归：宿主原生构建、CTest 1/1、56 项 Vitest、类型 / ESLint / Prettier / clang-format 通过；真实原生程序验证启动立即提示本机 CC 申请、异主机及未指定申请不可见、留言控制字符转义、不泄露轮询秘密且保持待审批。运行中新增 CW 的周期发现、原申请不重复提示，以及查询接口 503 后 Agent 保持在线并自动恢复检查均通过，随后完整端到端回归和进程退出通过。日志 `.local/agent-approval/notice-e2e.log`。
- 无外网 Bookworm 容器内完整 `test:e2e` 通过：真实 Wrangler、原生 Agent / CC、Chromium 验证服务停止时批准指定 CC、服务运行时批准 / 拒绝指定 CW、管理页目标锁定、HttpOnly Cookie 与刷新保留；原有管理员分配、API Key、多主机隔离、历史 / 文件 / 重连 / 撤销回归通过。Worker dry-run 通过，仅打包。
- 新增拒绝场景首轮因测试将带“关闭”按钮的提示框作整段文字精确匹配而超时；改为定位 alert 并匹配提示内容后，全量回归通过。截图已目视检查：[CW 指定目标申请](assets/agent-approval-2026-10-25/cw-request.png)。本地详细日志 `.local/agent-approval/e2e.log`。
- 本轮使用确定性 Codex 夹具与临时凭证，无模型调用，未部署；线上 0.5.4 不包含此功能。命令、权限边界和升级要求见 [用户手册](USER_GUIDE.md)。

## 0.5.4 · 2026-10-25 · 发布与线上验收

- 发布源码 `ba0f254` 与标签 `v0.5.4` 已推送到 GitHub。Worker 版本 `db1fb52b-5758-4a5b-b01f-c147b2331e0a` 于 UTC 01:38:34 发布到 `r.xlogic.cc`，流量 100%；普通部署保留生产密钥、DO 数据及原有用户授权。
- 干净 Ubuntu 20.04 / Debian 12 Release 构建通过，四个程序的版本、提交、protocol 和 sourceDigest `7d346ff032573d9ae09bba2213b8d72ec0132855ec40e86676c816b887f42240` 一致且 dirty=false。两个平台 CTest 均通过；50 项 Vitest、三项 HTTPS/WSS TLS 检查、类型/格式/协议检查、发行来源门禁通过。干净原生构建的更新器回归覆盖 CLI 默认自动安装及空闲 Agent 关闭存储后重启；在线 WAL 备份、恢复锁与内容校验通过。
- 两个平台发行包的运行程序字节与对应构建一致，源码归档等于 `git archive`。线上首页引用、JS/CSS、手册、下载清单及三个归档 SHA256 与本地一致；健康 200、未登录业务 401、跨域管理登录 403、安全头、手册 UTF-8 通过。实际下载 Ubuntu / Debian 两个平台程序均在匹配环境执行 help / --version 通过。
- UTC 01:40:06，真实 Chromium、实际下载的 Ubuntu Agent/CLI 和独立临时项目完成生产交互验证：A/CC 原生配对登录、CW 管理员选择服务器与作用域 Cookie、刷新保留、管理员/异主机隔离、撤销后的 401。下载版 Agent 使用确定性模拟 Codex 恢复历史并响应流式任务；历史连接收到 4 条实时事件，控制连接为 0，IndexedDB 已保存历史；新版网页上传和下载 300003 字节二进制文件，均逐字节一致。
- 浏览器无脚本错误，临时 A/CC/CW 授权及本次管理会话已撤销，测试进程结束；未修改已有用户设备、项目或调用模型。原生服务继续按用户已有自动更新配置升级，本次未直接替换其他主机上的服务。八小时长稳、慢盘控制延迟及原生 CLI 平台缓冲仍未声明验收完成。
- 永久证据：[部署身份](assets/perf-release-2026-10-25/deployment.json)、[包校验](assets/perf-release-2026-10-25/package-verification.json)、[线上资源](assets/perf-release-2026-10-25/online-verification.json)、[浏览器交互](assets/perf-release-2026-10-25/browser-verification.json)。本地日志和截图位于 `.local/perf-release-0.5.4/`；发布记录另行提交，不改写发布标签、源码包或在线手册。

## 0.5.4 · 2026-10-25 · 性能与完整本地历史（发布前验收）

本轮仅验证工作区修改，未部署、未调用模型。逐项映射、原始基准和边界见 [性能修复记录](perf-fixes-2026-10-25.md)。

- 原生/网页构建、CTest 1/1、六文件 50 项 Vitest、类型/ESLint/Prettier/clang-format 通过。新增原生批量事务回滚、Unicode 完整重建、SQL 异常后复用、上传乱序冲突及过期索引清理；Relay 覆盖在途鉴权撤销、独立接收者顺序/预算和唯一凭证复核。
- 独立 Chromium 的 `test:cache` 验证 3000 条历史、520 块正文保留，1000 个修订仅一个写事务，按 scope 清理和草稿/待确认身份保留。`test:ui` 验证完整 600 条历史和滚动锚点、重复阅读本地旧页不增加请求，并新增超过 128 Ki 字符的完整正文回归。
- 无外网 Bookworm 容器内真实 Wrangler、原生 Agent/CLI、Chromium 与确定性 Codex 的完整端到端通过；涵盖文件/历史、审批/去重/接管、授权/撤销和重连。Worker dry-run 仅打包。没有复用生产凭据。
- Store 四会话短基准：每批 128 条约 1.18 万–2.07 万 events/s，逐条提交约 1467–1602 events/s。每例仅一次，不能外推端到端收益或控制延迟；批次 P95 与事件 P95 不可直接相比。
- 完整历史窗口和本地保留优先，取消正文截断及应用层历史淘汰。浏览器配额、完整历史占用内存、原生 CLI 平台缓冲及八小时长稳仍有明确边界，未声明所有性能目标已验收。

## 0.5.3 · 2026-10-25 · 发布与线上验收

- 发布源码 `b6f9c0d` 和标签 `v0.5.3` 已推送。Worker 版本 `6f8083b8-cfc0-4423-b3e6-bd04003cb99f` 于 UTC 00:53:48 发布至 `r.xlogic.cc`，流量 100%。现有生产密钥与用户设备授权保留。
- 提交后的干净 Ubuntu 20.04 / Debian 12 原生构建均通过；两个平台归档的程序字节与构建产物一致，源码归档与 `git archive b6f9c0d` 一致，四个程序的构建身份绑定同一提交和 sourceDigest `13808d99c604353c3da189a74dcf1f4aec6e5cec36b4eeed08c3bc82c271f570`。干净构建的 CLI 默认自动安装和空闲 Agent 后台准备 / 重启回归亦通过；包校验记录 `.local/cc-request-approval/package-verification.json`。
- 线上 JS / CSS、手册及下载清单与本地发布内容一致；健康 200、未登录业务 401、跨域登录 403、安全头、UTF-8 文档和三个归档 SHA256 均通过。实际下载的 Ubuntu 两个程序在匹配系统运行 `--version` 通过，实际下载 Debian CC 在容器中用于下述生产登录。
- UTC 00:55:55，真实管理网页与实际下载的 0.5.3 CC 完成不传 `--host` 的中文留言申请、管理员选择临时 A、CC 保存正确角色 / 目标及 0600 凭证文件、目标 / 管理接口隔离、撤销后 401。CW 同时验证多行留言按纯文本显示、未选择 / 无效服务器拒绝、管理员选目标、Secure / HttpOnly Cookie 及刷新保留。测试完成仅清理本次临时 A/CC/CW 授权并撤销临时管理会话；无页面脚本错误，未操作用户已有设备或调用模型。
- 线上证据在 `.local/cc-request-approval-deploy/online-verification.json`、`browser-verification.json`、`registry-rollout.json`、`deploy.log` 和部署版本记录，截图同目录。本轮覆盖发布与登录，不表示真实生产 Codex 任务、长期负载或 DO 休眠升级已验收；既有开发预览边界保持。

## 0.5.3 · 2026-10-25 · CC 与 CW 统一留言申请（发布前验收）

- CC 配对登录使用 `--message TEXT` 传递选填留言，不再要求服务器标识；管理员在同一设备授权页查看留言并选择服务器。CC 使用批准结果的 hostId 保存原格式的私有多授权文件；已有凭证、服务器切换及固定目标的 API Key 登录继续可用。
- `npm test` 通过：CTest 1/1、Vitest 6 个文件共 47 项。CC / CW 共用用例覆盖留言类型 / 长度、申请端 hostId 不决定绑定、缺失 / 无效 / 撤销服务器、审批失败仍待处理、重复批准、单次领取与拒绝。`npm run build`（Ubuntu 20.04 原生构建、网页、类型检查、Worker dry-run）、Debian 12 原生构建、lint / lint:cpp、三项 TLS 检查、更新器回归及发布来源门禁均通过。
- Bookworm 容器中使用新版原生程序的完整 `test:e2e` 通过：真实 CC 无 `--host` 提交中文留言、真实管理网页选择服务器、保存正确角色 / 目标和 0600 权限；旧式 `--host` 参数不覆盖管理员所选服务器，第二次登录保留原授权。原有 API Key、CW 双服务器 Cookie、多标签页、隔离与撤销、历史 / 文件 / 重连回归通过。新增申请使原单 IP 测试准备超过每分钟 10 次限额，改为给模拟浏览器分配独立测试 IP；生产限流规则保持。
- 桌面 / 手机 `test:ui` 全部通过。测试使用模拟 Codex，未调用模型；尚未宣称跨网络任务或长期负载验收。日志与截图 `.local/cc-request-approval/`。

![管理员为 CC 留言申请选择服务器](assets/cc-request-approval-2026-10-25/admin-select-server.png)

## 2026-10-25 · CW 留言申请线上发布

- 源码 `2d1c675` 已推送至 master，Worker 版本 `3881ffd6-f618-4931-be15-b709183f277d` 于 UTC 00:34:28 发布至 `r.xlogic.cc`，流量 100%。原生下载保持 0.5.2。
- 线上首页与 JS / CSS 字节和本地构建一致；健康 200、未登录业务 401、跨域管理登录 403、安全头、UTF-8 手册字节和三个下载归档 SHA256 均通过。证据 `.local/cw-request-approval-deploy/online-verification.json` 与部署前后版本记录。
- 初始浏览器验收遇到 Registry 代码传播期间的旧申请校验；传播后 UTC 00:41:55 真实 Chromium 完成无服务器标识申请、多行留言显示、管理员选择临时 A、未选择 / 无效目标拒绝、单服务器 Secure / HttpOnly Cookie、刷新保留、管理 / 跨服务器隔离及撤销后的 401。测试仅创建独立临时 A/CW，完成后删除本次临时授权并撤销管理登录；未启动模型或操作用户已有设备。证据 `.local/cw-request-approval-deploy/browser-verification.json`。

## 2026-10-25 · CW 留言申请与审批选择服务器（发布前验收）

- CW 申请不再要求服务器标识，提交设备名称和最多 1000 字符的选填留言。管理员查看纯文本留言，明确选择未停用的服务器后批准；未选择时批准按钮不可用，拒绝无需选择目标。凭证仍按单台服务器隔离。
- `npm test` 通过：CTest 1/1、Vitest 6 个文件共 45 项。新增覆盖无目标 CW 申请、申请端 hostId 不决定授权、留言长度与类型、缺失 / 无效 / 已撤销服务器、审批失败后仍待处理、重复批准、单次领取及拒绝；CLI 仍必须在申请时指定目标。
- `npm run build:web`、`npm run typecheck`、`npm run lint` 通过。Bookworm 测试容器使用已发布 0.5.2 原生程序，真实 Wrangler / DO + Chromium 的完整 `test:e2e` 通过：多行中文留言及 HTML 按文本显示、管理员选择两台不同服务器、持久 Cookie 刷新保留、隔离 / 撤销，以及原有会话、历史、文件和重连回归。
- 同容器的 `test:ui` 通过：1280×900 桌面和 390×480 手机短视口下申请页无服务器标识，留言输入和申请按钮可见，无横向溢出；原菜单、草稿、审批和历史分页回归通过。截图在 `.local/cw-request-approval/`，以下保存申请页与审批区域截图。
- 本节记录本地验证，未调用模型；需同步发布 Worker 与网页，已有设备凭证无需重新申请。完整 `npm run build`（含原生构建、网页、类型检查、Worker dry-run）和 `test:tls` 三项信任链 / 主机名检查亦通过。

![手机 CW 留言申请](assets/cw-request-approval-2026-10-25/request-mobile.png)

![管理员查看留言并选择服务器](assets/cw-request-approval-2026-10-25/admin-select-server.png)

## 2026-10-25 · 功能菜单 CW / 管理员双模式

- 默认 CW 模式，只展示对话、会话和工作区功能；管理员模式只展示设备授权、API Key 与管理登录 / 退出。底部按钮切换模式，功能列表独立滚动。
- Chromium 合成 UI 回归通过：1280×900 桌面、390×480 手机短视口下检查入口互斥与底部按钮可见；键盘切换保留焦点，管理员登录 / 退出、未登录入口和授权深链接正确。切换后 CW 草稿保留，attach 计数不增加，原有授权、离线目录、分页和审批布局回归通过。日志 `.local/cw-menu-modes-ui.log`，截图 `.local/cw-menu-modes/ui/menu-{cw,admin}-{1280,390}.png`。
- 网页构建、typecheck、lint、Vitest 6 文件 43 项及 Worker dry-run 通过。测试不调用模型。
- Bookworm 隔离容器中的完整 e2e 与 UI 压力均通过：真实 Wrangler / DO、已发布 0.5.2 原生程序及 Chromium，覆盖新版管理员登录入口、设备审批、API Key、CW 多 A 授权 / 切换、会话与文件、重连及撤销；日志 `.local/cw-menu-modes/e2e.log`。
- 2026-10-25 07:46（Asia/Shanghai）源码提交 `5ddc50d7dd06ceb8fbe82740f79819c20bfa8688` 已推送并部署到 `https://r.xlogic.cc`。Worker 版本 `11bfb5cd-f498-4bc4-8892-8abeb1a0bbc4`，部署 ID `d066c48c-14f2-40c1-96d2-d5bcb5f6a830`，部署列表确认 100% 流量。部署前重新构建网页并通过 Worker dry-run、文档格式及下载归档 SHA256 检查；在线手册同步更新，原生发行仍为 0.5.2。
- 线上首页引用新 JS / CSS，字节与本地构建一致；健康 200、未登录业务 401、跨域登录 403、安全头、在线手册 UTF-8 / 文档字节、原生清单及三个归档 SHA256 全部通过。线上 Chromium 在 390×480 下验证未登录 CW / 管理员菜单入口互斥、双向切换、管理员登录表单隔离、底部按钮可见，在线手册实际字符集为 UTF-8，无页面脚本错误。证据 `.local/cw-menu-modes-deploy/online-verification.json`、`browser-verification.json`、`deploy.log`、`deployments-after.json`。线上检查使用未登录浏览器和 HTTP，授权后的交互由本地真实 Wrangler e2e 验证；本次未创建生产设备或操作既有会话，未调用模型。

![手机短视口 CW 模式与底部切换按钮](assets/cw-menu-modes-2026-10-25/cw-mobile.png)

![手机短视口管理员模式与底部切换按钮](assets/cw-menu-modes-2026-10-25/admin-mobile.png)

## 2026-10-25 · 会话记录连接设置与滚动分页

- 连接设置移至会话记录面板顶部，覆盖主机 / 项目、创建会话、登录与授权；手机布局将选择框与操作按钮分行展示，聊天区继续保留在弹窗后方。
- Chromium UI 回归通过：两组各 600 条消息分别验证手动加载和向上滚动自动异步加载，延迟响应期间滚动事件不重复发请求，读取失败可重试，首次及后续分页均保持阅读位置，完整保留超过 400 条 / 192 KiB 的内容，已读旧页命中 IndexedDB，读至开头后不再自动请求。截图 `.local/cw-scroll-history/ui/cw-session-connections.png`、`cw-loaded-history.png`。
- 网页构建、Worker dry-run、typecheck、lint 与 Vitest 6 文件 43 项通过。自动分页未命中离线缓存时，提示放在消息区内，避免常驻全局提示挤压聊天区域。未调用模型。
- Bookworm 隔离容器中的完整 e2e 与 UI 压力最终全部通过：真实 Wrangler / DO、已发布 0.5.2 原生程序及 Chromium，覆盖调整后的登录、多 A 授权 / 切换、创建与恢复会话、桌面 / 手机布局、审批、文件、重连及撤销；日志 `.local/cw-scroll-history/e2e.log`。截图位于 `.local/cw-scroll-history/container-screenshots/`。
- 2026-10-25 07:35（Asia/Shanghai）源码提交 `299a14d00757f403c979b781d55f7a63c1708de2` 已推送并部署到 `https://r.xlogic.cc`。Worker 版本 `0f30bdd8-dd2e-410d-ba74-e679c60957c7`，部署 ID `f225e0c0-aee7-4ec8-b6a1-53938d3fecb5`，部署列表确认 100% 流量。部署前再次通过网页构建、Worker dry-run、typecheck 和 lint，三个既有下载归档 SHA256 均通过；在线手册同步更新，原生发行仍为 0.5.2。
- 线上首页引用新资源，JS / CSS 与本地构建字节一致；健康 200、未登录业务 401、跨域登录 403、安全头、在线手册 UTF-8 / 文档字节、原生清单及三个归档 SHA256 全部通过。证据 `.local/cw-scroll-deploy/online-verification.json`、`deploy.log`、`deployments-after.json`。线上范围为未登录 HTTP 与静态产物检查，交互行为由本地 Chromium / 真实 Wrangler e2e 验证；本次未创建生产设备或操作既有会话，未调用模型。

![手机会话记录顶部的连接设置](assets/cw-history-2026-10-25/session-connections-mobile.png)

## 2026-10-25 · CW 完整显示已加载历史

- 新增 Chromium 回归在修复前复现：累计取得 450 条消息，DOM 只显示 400 条。
- 修复后 `npm run build:web` 与 `npm run test:ui` 通过。短消息、较大消息两组各 600 条，按每页 150 条连续加载，均完整有序显示；越过 400 条 / 192 KiB 后不裁剪，后续加载保留阅读锚点。返回最新恢复有界窗口，重新加载三个旧页命中 IndexedDB，无额外历史页网络请求。
- `npm run typecheck`、`npm run lint`、Vitest 6 文件 43 项通过。本次仅修改网页历史合并逻辑，浏览器使用合成 API / WebSocket；未调用模型。截图：`.local/cw-history-regression-after/cw-loaded-history.png`。
- 部署前再次通过网页构建、Worker dry-run、UI 压力及完整 e2e。宿主 Wrangler 启动不兼容，改用 Bookworm 隔离容器、已发布 0.5.2 Debian 原生包、真实 Wrangler / DO 与 Chromium，验证历史、权限、审批、文件和重连；测试工作区不包含生产凭据。日志 `.local/cw-history-deploy/e2e.log`。既有三个下载归档的 SHA256 全部通过，原生清单保持 0.5.2。
- 2026-10-25 07:17（Asia/Shanghai）源码提交 `8d40f89f54e636793025a7c89ff57cae15874fe9` 已推送并部署到 `https://r.xlogic.cc`。Worker 版本 `5b3b63ef-c56b-459a-8adf-f89cd12bd148`，部署 ID `2680ece8-0c00-4ca0-b732-2794f3a6c5b8`，部署列表确认 100% 流量。线上首页引用新 JS，JS / CSS 字节与本地构建一致；健康 200、未登录业务 401、跨域登录 403、安全头、手册 UTF-8 与文档字节、三个归档 SHA256 及原生清单均通过。证据 `.local/cw-history-deploy/online-verification.json`、`deploy.log`、`deployments-after.json`。线上使用未登录 HTTP 检查，600 条历史交互由本地 Chromium 回归验证；本次未创建生产设备或操作既有会话。

## 0.5.2 自动更新与生产发布验证

2026-10-24 23:52（Asia/Shanghai）发布至 `https://r.xlogic.cc`。Worker 版本 `e440d059-e38a-475e-ac45-0aa9261c337b`，部署 ID `b5269035-c324-4bf1-b495-db4b8bbc4242`，实际部署列表确认承接 100% 流量。提交与 `v0.5.2` 标签已推送；发行源码为 `e3a4e05`，源码摘要为 `0fee8019026de86763f2d5345da0a75dee4d681aafa3c8d480ff17485ab75329`。发布后的测试夹具/CI 与证据修正另行提交，不改写标签或线上运行产物。

- Ubuntu 20.04 / Debian 12 分别完成干净 Release 构建，两个平台包与源码包共三个归档通过 SHA256 和构建身份门禁；实际解压执行 help/version。CTest、6 文件 43 项 Vitest、格式/类型/协议、备份恢复、发布来源、真实 Codex 0.164.0 无模型初始化检查通过；clang-format 10 与 18 输出一致。
- 真实 ELF + 回环 HTTP 测试通过：Agent/CLI 手动安装、旧文件/权限保留、归档无关及穿越成员不落盘、坏 SHA256 / 错提交 / 不兼容协议拒绝、旧版不下载、配置关闭不发请求、并发更新互斥。均操作临时程序副本。
- 干净发行构建通过 CLI 命令结束自动安装；两个平台通过空闲 Agent 后台准备、释放存储并 exec。额外通过带真实原生 runtime 的检查：候选已准备，超过第一次空闲检查仍保持原进程和原程序；停止会话后才原子安装并重启。未调用模型。
- 最终真实 Wrangler/DO、原生程序及 Chromium e2e 和 UI 压力全部通过，Worker dry-run 通过；包括停止后的历史分页、审批、文件、重连、草稿、连续工具默认折叠及短视口。早期回归发现关闭中历史进程被误复用，已修复；空闲重启曾偶发超时，改为业务执行器排空后停止网络循环，最终验证通过。
- 线上安全头、JS/CSS 字节、健康 200、未登录 401、跨域 403；实际下载三个归档的 SHA256 / 源码身份、手册 UTF-8 / 浏览器字符集 / 源文件字节均通过。下载的 Agent 和 CLI 的 `update` 实际访问线上清单并返回 Already up to date，无替换现有版本。
- 线上临时 API Key 和配对 A/CC、CW Cookie、角色/目标隔离、510 条目录与中文正文分块、CW IndexedDB、CC 在线/离线缓存、恢复线程及确定性任务通过。撤销本次临时授权、退出管理后旧 Cookie 被拒绝，临时进程与凭据已清理；未修改用户已有设备、服务或 OWNER_SECRET。

远端 CI 的 ASan/UBSan 已通过。regression 的依赖安装已修复并通过（retry 0.4.3、type-check 0.4.0）；其后 TLS 夹具对所有 HTTP 请求断言业务凭据，误拒绝新加入的无凭据更新请求。发布后修正夹具为显式关闭自动更新，TLS 独立回归通过；更新网络请求由专用 ELF/HTTP 用例验证。2026-10-25（Asia/Shanghai）提交 `67e737a` 的[远端 CI](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40109322123) 完整通过：regression（构建、全部独立回归、浏览器 e2e 与 UI 压力）及 ASan/UBSan 均成功；此前失败保留为历史记录。

0.5.1 及更早版本需首次手动安装 0.5.2 才获得自动更新；安装目录须归运行用户所有且可写。保留上一版下载及部署信息，未执行生产回滚、真实 DO 休眠/升级、八小时负载、掉电或真机辅助技术验收；原有稳定化边界继续有效。

## 0.5.1 稳定化验证

| 检查                               | 本轮结果与限制                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生 Release 构建与 CTest          | 通过；覆盖 100000 会话目录、1.1MiB 流重建、版本内容、持久请求/上传、配置锁、HTTP/TLS 停滞、SQLite 锁等待与子进程                                                    |
| Vitest                             | 6 个文件、42 项通过；协议共享样例、认证、租约竞争、慢读者预算、事件合并、API deadline/HTML 错误                                                                     |
| 真实 Wrangler / C++ / Chromium e2e | 全部通过；安全头、真实 DO 并发附着、丢 attach ACK 保留旧控制者、任务幂等、CLI TUI、浏览器、文件、撤销和 Agent 重连                                                  |
| Chromium UI 压力                   | 通过；两次票据 503 后恢复、连续工具默认折叠、长内容连续读取、草稿刷新、丢 prompt ACK 不重发、文件审批 diff、390×844/480 下 0/1/3/10 长审批、菜单/弹窗/焦点/离线入口 |
| TLS                                | 可信证书、未知 CA、错误主机名均通过，覆盖 HTTPS/WSS                                                                                                                 |
| 备份恢复                           | 活跃 WAL、一致性、0600 权限、恢复实例锁与内容恢复通过                                                                                                               |
| 发布来源                           | 隔离 Git 仓库中匹配构建可打包；未跟踪文件脏树与陈旧提交二进制被拒绝；实际两个平台发行包及源码包另经发布验证                                                         |
| 静态与构建检查                     | typecheck、lint、lint:cpp、protocol:check、网页构建和 Worker dry-run 通过；dry-run 不发布                                                                           |
| ASan/UBSan                         | Debug 构建完成；重新构建测试后 CTest 两次通过（139.20s、42.93s）。初次测试曾反复输出 DEADLYSIGNAL、无可用堆栈并主动终止；不将该次算通过，亦未据此断言已定位根因     |

真实 Codex 0.164.0 的 `npm run test:codex` 已通过 initialize + thread/start，不调用模型；`coc-agent doctor` 对本地健康接口、真实 Codex 版本、配置/项目/磁盘与 SQLite quick_check 通过。

本次增加仓库 CI 与可选 libFuzzer harness；持续模糊测试尚未执行。首次远端 Actions 的 regression 在 npm ci 失败，本地隔离安装复现为 @humanfs/node 要求尚不存在的 @humanwhocodes/retry ^0.5.0，锁文件只有 0.4.3；不能将该次远端 CI 算作通过。随后 overrides 固定已发布的 retry 0.4.3，隔离目录 npm ci 成功安装 280 个包。生产验证见下节。四会话八小时、真实平台休眠/升级/回滚、磁盘耗尽/强制断电、Firefox/WebKit、手机软键盘、屏幕阅读器及完整对比度/200% 缩放尚未验收。

截图来自本地确定性数据，无真实凭证。短视口代表尺寸压力，不能替代真机键盘测试：

![桌面聊天与常驻上下文](assets/stabilization-2026-10-24/cw-chat-desktop.png)

![手机三项审批，固定决定按钮与停止入口](assets/stabilization-2026-10-24/approvals-844.png)

![390×480 短视口三项审批](assets/stabilization-2026-10-24/approvals-480.png)

![工作区文件目标和进度](assets/stabilization-2026-10-24/cw-workspace-files.png)

### 四会话短时存储基准

完整 JSON 见 [基准原始结果](assets/stabilization-2026-10-24/stream-benchmark.json)。在共享 Ubuntu 20.04 开发机上使用默认 SQLite WAL 耐久设置，每项最多追加 30 秒，四会话交错写入并校验尾部正文。P95 每 16 个事件采样一次；不包含网络或 Cloudflare，不代表端到端延迟。

| 增量字符 | 每会话目标 | 每会话实际字符 | 事件数 | 采样事件 P95 | CPU 秒 | RSS 峰值 | WAL 峰值  |
| -------- | ---------- | -------------- | ------ | ------------ | ------ | -------- | --------- |
| 1        | 1048576    | 1324           | 5296   | 49.72 ms     | 2.35   | 8192 KiB | 4152992 B |
| 10       | 1048576    | 4030           | 1612   | 131.48 ms    | 0.56   | 7296 KiB | 4144752 B |
| 100      | 1048576    | 54900          | 2196   | 115.57 ms    | 0.80   | 7808 KiB | 4157112 B |
| 1000     | 4194304    | 346000         | 1384   | 149.93 ms    | 0.40   | 8704 KiB | 4157112 B |

四项均 `completed=false`：时限内未达到 1MiB/4MiB 目标，只能作为短时部分负载记录。共享磁盘上的同步持久提交延迟明显，尚不能据此验收吞吐或八小时稳定性；网络心跳 P95 也未测量。功能回归另用 1.1MiB 内容完成全部重建校验，不能与这里的性能结果混为一谈。

## 0.5.1 生产发布验证

2026-10-24 23:23（Asia/Shanghai）部署到 `https://r.xlogic.cc`。Worker 版本为 `2b3ce628-db48-4bc7-b8d4-87bf27ae200b`，部署 ID `33e6c362-4a47-4c05-8d1c-b357d024cfaa`，部署列表确认承接 100% 流量。发布源码为 `4f5b9db`，源码摘要为 `60d52ecd631aa6e592ff5ab1e5320689f35fce954abad9b1634cfc5b13775e12`；提交与 `v0.5.1` 已推送远程。证据文档在发布后另行提交，不改写发行标签。

- 线上首页 CSP、nosniff、Referrer-Policy、禁止嵌入响应头，以及实际 JS/CSS 字节与构建产物一致；健康接口 200、未授权接口 401、跨域管理登录 403。
- 实际下载 Ubuntu 20.04 / Debian 12 包及源码包，三个 SHA256 均与本地发行产物一致。两个平台分别解压并在兼容系统执行 help/version；均为两个运行程序，版本 0.5.1、protocol 1、干净源码身份。手册响应 UTF-8、Chromium 字符集与源文件字节一致。
- 下载的 Debian 12 Agent/CC 与真实管理网页完成临时 API Key 直接登录、并行配对批准、CW 持久 Cookie 登录、目标主机隔离和管理接口拒绝。通过真实 Worker 双向只读历史通道验证 510 条目录分页、中文大正文分块、CW IndexedDB 与 CC 在线/离线 SQLite 缓存。
- 临时 Agent 连接确定性 Codex 夹具，通过线上 CW 恢复本地线程、提交任务并显示 Markdown/表格及默认折叠的工具。此处没有模型调用，不代表真实生产模型任务或长期负载验收。
- 撤销本次临时主机/Key/客户端授权后请求被拒绝；管理员退出后重放旧 Cookie 返回 401。临时子进程与凭据已清理，未修改用户已有设备、项目、服务或 OWNER_SECRET。

现有 Agent/CC 仍需用户升级至配套 0.5.1；旧 Agent 未完成能力协商会被拒绝控制。保留上一版下载与部署信息；本轮没有实际执行生产回滚、真实 DO 休眠/升级或八小时压力。

## 历史验证时间线

以下记录描述当时版本，不覆盖或替代上表的当前工作树结果。

## 环境

- 宿主：Ubuntu 20.04、glibc 2.31、GCC 9.4、CMake 4.2.3、Boost 1.71、OpenSSL 1.1.1f、SQLite 3.31.1、nlohmann/json 3.7.3。
- 工具：Node.js 22.17、Codex 0.164.0、clang-format 10。
- 集成容器：Debian Bookworm、GCC 12、Boost 1.74、OpenSSL 3、SQLite 3.40、nlohmann/json 3.11、真实 Wrangler/workerd 与 Playwright Chromium。
- 宿主与容器分别构建二进制，避免混用系统动态库。测试使用临时项目、凭据、端口和 DO 状态，上述本机测试未连接生产 `r.xlogic.cc`，生产冒烟另见下节。

## C++ 迁移验证

| 检查            | 证据与边界                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生构建        | CMake 构建 `coc-agent`、`coc`、`coc-tests`，支持宿主及 Bookworm 工具链。                                                                                                                        |
| CTest           | URL / 命令校验、RPC 白名单与线程隔离、服务器权限、凭据脱敏、SQLite 去重 / 回放 / 重启、旧请求指纹顺序、私有文件权限、独占 dataDir、真实子进程双向 RPC 与审批拒绝。测试断言在 Release 下仍有效。 |
| Vitest          | 两项保留的 TypeScript 协议边界测试：TLS / 回环 URL、帧大小和未知网页命令。                                                                                                                      |
| 原生 CLI        | 端到端直接启动 `coc`，验证登录、登记码、Agent 配置、文件权限、主机 / 项目 / 会话查询、结束会话、撤销和退出登录。TUI 启动夹具验证参数与环境变量票据传递。                                        |
| 中继与网页      | C++ Agent + 真实 Wrangler + 模拟 Codex + Chromium：认证、Origin 拒绝、单次登记、项目限制、流式输出、重复 prompt 去重、审批拒绝、接管、票据复用拒绝和历史回放。                                  |
| 故障恢复        | 测试代理断开 C++ Agent 连接，保留 Codex runtime 并恢复网页历史；设备撤销关闭活动连接并停止 Agent。                                                                                              |
| HTTPS / WSS     | 临时 CA 和服务器证书：可信证书连接成功；未知 CA、错误 SAN 主机名均被拒绝；验证 owner / device Bearer 认证头。                                                                                   |
| 真实 Codex 协议 | `npm run test:codex` 使用 C++ 进程层初始化 app-server 并创建只读临时线程，不提交模型任务。                                                                                                      |
| 真实文件任务    | `npm run test:task` 使用 C++ 进程层，在临时项目创建 `proof.txt`，精确校验内容为 `coc-smoke-ok\n` 并清理；调用已配置模型。                                                                       |
| 真实原生 TUI    | `npm run test:native -- --task`：Codex TUI → 本机 Worker → DO → 宿主 C++ Agent → Codex，完成一轮只读模型对话。通用 `command/exec` 和提交后新建线程探测仍被明确拒绝。                            |

`test:e2e` 的模拟 Codex 不执行命令、不调用模型；其中 TUI 启动夹具只记录参数，不验证终端 UI。真实 TUI 和真实文件任务由独立 smoke 证明，不能相互替代。

## 发现与修复

TLS 回归测试发现 Boost 旧 RFC2818 回调在 SAN 不匹配时仍可能回退到 CN。实现改用 OpenSSL 主机名 / IP 验证参数，HTTPS 与 WSS 使用相同约束。测试证书特意使用匹配 CN、错误 SAN，防止该问题回归。

原 TypeScript 的 JSON 指纹使用字段插入顺序，nlohmann/json 默认按键排序。C++ 显式保留旧请求字段顺序，避免已有 SQLite 去重记录在迁移后发生错误冲突。数据库表结构保留，重启会将旧活动会话标记失败。

宿主无法直接运行新版 workerd，仍使用 `Dockerfile.test` 容器；未替换宿主 glibc。原 TypeScript Agent / CLI 已删除，集成工具通过子进程调用 C++ 二进制。Node.js 仅用于云端、网页和开发测试工具。

## 0.2.0 首次生产发布

2026-10-24 已发布至 `https://r.xlogic.cc`，首发 Worker 版本为 `e25cac8c-596e-4351-b319-27b2d12c5674`；后续同步发布文档及最终源码包。域名绑定到 `codex-over-cloudflare`，生产 `OWNER_SECRET` 确认为 Cloudflare `secret_text`，未提交密钥。

- 用户确认浏览器可以直接访问首页。
- HTTPS 首页和 `/api/v1/healthz` 返回 200；未登录查询主机返回 401，跨域登录请求返回 403。
- 已用 Debian 12 C++ 客户端在生产完成登录、主机查询及退出，使用独立临时凭据文件；未登记设备或调用模型。
- 下载页提供 Ubuntu 20.04、Debian 12 的 Linux x86_64 包与源码包；三个线上包均通过 SHA256 校验。
- 解压 Ubuntu 原生包后，在不含 Node.js 的 PATH 下可直接执行 CLI。

本机路由器曾缓存新域名的解析失败；发布验证仅在测试进程 / 临时容器中指定 Cloudflare 边缘地址，保留完整 HTTPS 主机名与证书校验，未修改系统 DNS。用户浏览器的正常访问独立确认域名可达。

## 下载手册编码修复

2026-10-24 复现：线上 Markdown 文件字节为正确 UTF-8，但响应头 `text/markdown` 未声明字符集。新增静态资源响应头规则，将 `/downloads/*.md` 设置为 `text/plain; charset=utf-8`。

本机真实 Wrangler + Chromium 验证通过：响应状态 200，响应头包含 UTF-8，`document.characterSet` 为 `UTF-8`，正文包含“用户手册”和“服务端、客户端与网页”，且响应字节与文档源文件一致。此次仅修改网站响应头和文档，保留 0.2.0 已发布安装包。

生产 Worker 版本 `0d8322b3-5744-4909-bcce-2aeaab02b9a5` 已通过同一 Chromium 检查，线上响应为 `text/plain; charset=utf-8`；三个安装 / 源码包的 SHA256 校验仍通过。

## 0.2.1 一次性客户端登录

2026-10-24 本机验证通过：管理员网页生成验证码和浏览器链接；C++ CLI 兑换后保存 0600 凭据；链接清除地址栏 fragment，点击登录后获得网页会话。CLI 与网页并发兑换仅一次成功，已用验证码不能复用，未登录 / 客户端角色不能生成授权。验证码 5 分钟到期，登录凭据有效 8 小时；本轮未等待完整到期时间验证。

宿主和 Bookworm 容器原生构建、CTest、Vitest、TypeScript 类型检查、ESLint / Prettier、clang-format 检查、网页构建及 Worker dry-run 均通过。完整 `test:e2e` 使用真实 Wrangler / Chromium / C++ 程序与模拟 Codex，覆盖新登录流程及原有会话、流式输出、审批、重连和设备撤销；截图保存为 `.local/login-link.png` 和 `.local/login-session.png`。以上为本机验证，生产发布结果另行记录；未调用模型。

0.2.1 已发布至 `https://r.xlogic.cc`，Worker 版本为 `d79baa69-5514-4b34-9cb3-061c367d7d5f`，发布源码提交为 `e24ea6b`。生产 Chromium 验证管理员网页生成链接、浏览器确认登录、验证码复用拒绝及客户端生成授权返回 403；实际下载的 Debian 12 C++ CLI 完成验证码登录、主机列表和退出，使用独立临时凭据。两个二进制包和源码包线上 SHA256 校验通过；在线手册 UTF-8 响应头、浏览器字符集及源文件字节一致。测试登录均已退出，未登记 / 撤销生产设备，未调用模型。

## 网页流式文字顺序修复

2026-10-24 通过延迟首帧鉴权、立即完成次帧鉴权的回归测试复现：旧 HostRelayDO 在首帧前转发次帧；网页又按到达顺序拼接，导致回复单词错位。中转现按每条 WebSocket 连接串行处理，网页按持久事件 `seq` 排序、去重后拼接。

CTest、6 项 Vitest、类型与格式检查通过。完整 Wrangler + C++ Agent + Chromium 集成使用模拟 Codex 逐字快速发送英文和中文，验证原始事件顺序、完整文字及刷新页面后的两轮历史回放；原有登录、审批、重连和撤销回归通过。单元测试另验证乱序、重复事件、不同消息与轮次边界，以及一条连接等待鉴权时其他连接仍可转发。截图：`.local/stream-order.png`。本轮未调用模型，不涉及 Agent 升级。

已部署至 `r.xlogic.cc`，最终 Worker 版本为 `1020ab0d-eee2-4a90-9ddd-697f3d8f909e`。Chromium 加载线上实际网页代码，使用隔离的 API / WebSocket 夹具验证刻意打乱的实时片段和逆序、重复历史均还原为 `Hi! What would you like to work on?`，完成状态保持空闲；该检查不操作真实生产会话，也不代表生产模型输出验收。线上用户手册 UTF-8 校验、下载页，以及保留的 0.2.1 清单、校验文件和三个发布包均验证通过。截图：`.local/stream-production.png`。

## 0.2.1 当时未完成的验收（历史记录）

- 生产 DO 休眠唤醒、跨网络会话和发布断线；HTTP 发布冒烟不覆盖这些场景。
- 4 会话持续 8 小时、P95 延迟、1 GiB 配额与慢客户端长期压力。
- CLI 再附着、Agent 重启后的旧线程恢复、超大事件分片。
- 全部审批类型、全部原生 TUI 功能、macOS / Windows 和移动浏览器兼容性。
- 组织账户、强租户隔离、端到端加密；这些不在首版本机实现范围。

复现命令见 [开发说明](DEVELOPMENT.md)。不要将本记录视为 A-01 至 A-09 全部验收完成。

## 0.3.0 统一设备授权与双程序

2026-10-24：本地程序调整为 `coc-agent` / `coc-client`，不再构建和分发旧 `coc`。项目配置和 SQLite 格式保留，认证 version 2 为不兼容升级，所有旧凭证需要重新授权。

- 宿主 Ubuntu 20.04 和 Debian 12 容器均构建两个程序；原生共享 login 接口负责参数、路径、申请 / 轮询和状态检查。
- CTest 通过；13 项 Vitest 覆盖多年后凭证仍有效、旧凭证拒绝、并发审批 / 单次领取、轮询秘密、请求过期 / 拒绝、未领取授权清理、撤销释放有效主机配额、角色 / 目标 A / 管理权限隔离，以及原有协议和流式顺序回归。多年有效性由时钟推进测试验证，不代表多年实测运行。
- 真实 Wrangler + C++ 程序 + Chromium 集成通过原生 A 自行登录、CC 多 A 私有凭证文件、管理员网页审批 CW、持久化 HttpOnly Cookie、多授权刷新保留、两个在线 A 在不同标签页独立控制、撤销后保留另一个 A 的授权、会话和中文 / 英文流式历史、审批拒绝、幂等、票据复用拒绝、Agent 重连及管理撤销关闭活动 CW / CC / A 连接。只使用模拟 Codex，不调用模型。
- TLS 测试通过可信证书连接、未知 CA 拒绝、SAN 主机名错误拒绝；真实 Codex `initialize` / `thread/start` 与原生 TUI 经完整本机中继初始化通过，未提交模型任务。沙箱最初阻止临时监听和 Codex 进程，授权后重跑通过。
- TypeScript 类型、ESLint / Prettier、clang-format 检查和完整 build / Worker dry-run 通过。Docker 生成目录的所有权已恢复后完成宿主构建。
- 截图保存在忽略目录 `.local/auth-multiple.png`、`.local/auth-session.png`。发布结果另行记录。

浏览器 Cookie 的本地期限由浏览器约束，网站在主机查询时续写；清理 Cookie 或长期未访问仍需重新申请。管理会话单独有效 8 小时。以上不覆盖真实模型任务、生产长连接负载和 DO 休眠恢复。

### 0.3.0 生产发布

已于 2026-10-24 发布至 `https://r.xlogic.cc`，Worker 版本为 `ee650082-1424-47da-babb-9442217d554b`（100% 流量），发布源码提交 `a56361e27273b105abf870d2c39c57dc861fe4fd`。

真实 Chromium 管理网页核对并批准本次临时 A / CC / CW 请求：实际下载的 Debian 12 两个程序完成登录与状态查询，CW 的 Secure / HttpOnly 长期 Cookie 在刷新后保留；CC / CW 访问管理接口被拒绝。测试后撤销本次创建的全部设备授权，确认 CC 旧凭证返回 401；未修改已有生产设备，未启动生产 Codex runtime 或调用模型。

两个发行包和源码包线上 SHA256 均与清单一致，下载目录仅提供 0.3.0；二进制包包含 `coc-agent` / `coc-client`，不含旧 `coc`。在线用户手册响应头包含 UTF-8，浏览器实际字符集为 UTF-8，正文与文档源文件字节一致。生产截图：`.local/auth-production.png`。源码和发布证据已提交推送；`v0.3.0` 标签指向发布源码提交，证据文档另作后续提交。

## 0.3.1 角色专用 API Key

2026-10-24：增加与配对审批并行的 API_KEY。CC Key 创建时固定目标 A；A Key 首次使用事务绑定自己的 A。登录返回元数据，原 Key 保存在 token 字段并直接用于鉴权。

- CTest 与 17 项 Vitest 通过，新增覆盖角色必填、CC 创建必须选 A、跨角色 / 跨 A 拒绝、直接 Bearer 鉴权、并发首次绑定只创建一个 A、十年后仍有效、只保存摘要、未使用 Key 撤销、客户端独立撤销与 A 级联撤销。
- 原生 Ubuntu 20.04 / Debian 12 编译通过。类型、ESLint / Prettier、clang-format、完整 build 和 Worker dry-run 通过；可信 TLS、未知 CA 与错误主机名回归通过。
- Wrangler + Chromium + 两个 C++ 程序新增场景通过：管理员网页生成两类 Key、环境变量 / 标准输入登录、配置中的 token 等于原 Key、A 重复登录保持绑定、CC / A 活动 WebSocket 撤销立即关闭。完整回归发现本地 workerd 偶发在已交付 4001 关闭帧后延迟结束 TCP，导致测试超时；诊断确认客户端已收发关闭帧。测试客户端设置 1 秒关闭握手期限，并明确断言收到 4001 撤销码；配对 CC 另外按实际凭证摘要精确选择。

本轮使用模拟 Codex，不调用模型；多年有效性为时钟推进验证。截图在忽略目录 `.local/api-key-management.png`。修正测试传输关闭等待后，完整端到端回归已通过，包含原配对 CC / CW / A 撤销、重连、多 A 多标签页、流式历史、审批与原生 TUI 启动。生产发布证据另行补充。

### 0.3.1 生产发布

已于 2026-10-24 发布至 `https://r.xlogic.cc`，Worker 版本 `3ea27462-6e50-488d-bde0-ad73581c7d24`，部署记录显示 100% 流量；源码提交 `9dd7a32f188d4fa8c45c843117535735593bf6b0`，`v0.3.1` 标签指向该提交。

初次生产验证时新网页与 Worker 已生效，Registry 新操作仍短暂返回 `NOT_FOUND: Unknown operation`；随后同一部署下生成 / 撤销探测成功，完整验证重跑通过。这与 Cloudflare 文档描述的 Worker / Durable Object 代码更新最终一致传播相符，未清空存储或更改已有设备身份。开发文档已补充部署后等待实际接口就绪的检查。

真实 Chromium 管理网页生成 A Key 和指定目标 A 的 CC Key；实际下载的 Debian 12 两个程序完成直接 Key 登录，配置中的 token 等于原 Key。配对 CC 与 CW 登录继续可用，CW Secure / HttpOnly 持久 Cookie 刷新保留，Key 和配对客户端均不能访问管理接口。撤销 CC Key 后旧 Key 返回 401，撤销 A Key 后本次 A 停用；本次临时设备与 Key 已清理，未修改其他生产设备，未运行生产 Codex runtime 或调用模型。

Ubuntu 20.04、Debian 12 二进制包与源码包的线上 SHA256 均与清单一致；下载清单版本为 0.3.1，源码提交与发布标签一致，二进制包含两个程序及 `--api-key` 登录支持。在线用户手册与源文件字节一致，响应头和真实浏览器字符集均为 UTF-8。截图：`.local/api-key-production.png`、`.local/auth-production.png`。本节和发布传播注意事项为源码发布后的证据补充，不改变该标签或已发布源码包。

## 0.4.0 CW 工作台与 Codex 本地历史

本机验证，不连接生产、不调用模型：

- Ubuntu 20.04 / Debian 12 原生 Release 构建、CTest、18 项 Vitest、TypeScript、ESLint / Prettier、clang-format 与 Worker dry-run 检查通过；可信 TLS、未知 CA 与错误主机名回归通过。
- 真实 Wrangler / Durable Object + 原生 Agent / Client + Chromium，使用确定性 Codex 协议夹具：既有认证、角色 / 主机隔离、审批、接管、重放、撤销、多标签页与断网重连继续通过。
- 新增历史列表 cwd 过滤、中文长摘要 UTF-8 完整性、异项目 / 异主机恢复拒绝；浏览器恢复用户 / 助手消息及工具结果，继续发送新任务；分页去重、搜索、Markdown 表格 / 代码块、安全链接、默认折叠工具、键盘提交、功能分页、Escape 与菜单自动收起通过。
- 390px 手机布局无横向溢出。截图：`.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`、`.local/cw-chat-markdown.png`；已目视检查布局并将可能缺字的图标替换成 SVG。
- 与真实 Codex `0.164.0` 本地生成的 JSON Schema 核对 `thread/list`、`thread/read`、`thread/resume` 参数；本轮没有用真实模型生成 / 恢复实际用户对话，也没有验证超大历史。既有 256 KiB 单帧限制保留，归档和其他 cwd 的线程不在当前列表中。

需要同步更新 Worker / 网页和原生 Agent。生产验证记录另行补充。

### 0.4.0 生产发布

2026-10-24 已发布至 `https://r.xlogic.cc`。Worker 版本 `735711eb-c7f8-47bc-b49b-f02129edc4ba`，部署记录为 100% 流量；源码提交 `bf561359aaaa6186adfb82e8ad5341121886eca7`，GitHub `master` 与 `v0.4.0` 发布标签已推送并核对。

线上三个包（Ubuntu 20.04、Debian 12 和源码）SHA256 与清单及本机发布产物一致，下载清单版本 / 提交与发布源码一致；包内只有 `coc-agent` / `coc-client` 两个运行程序，已在匹配系统检查 help。在线用户手册与源文件字节一致，响应头与 Chromium 字符集均为 UTF-8。首页 / 健康检查正常，未登录业务返回 401，跨域管理登录返回 403。

真实 Chromium 管理页创建临时 A / CC Key，下载的 Debian 12 两个程序完成直接 Key 登录，CC 配对登录与 CW Cookie 登录继续通过，验证角色隔离和撤销后的 401。使用该临时 A、独立临时目录及确定性模拟 Codex 连接生产中继，新版下载 Agent 的本地历史查询 / 恢复、恢复后 CW 发送任务及流式回复、Markdown 表格、工具默认折叠、功能页切换均通过；不调用模型，不涉及用户原有设备或真实项目。临时设备 / Key 已撤销，测试 Agent 停止。截图 `.local/cw-production.png`。

本次发布只更新云端网页 / Worker 和下载包；已有远程主机须安装 0.4.0 `coc-agent` 并重启服务才能使用新增历史接口。发布证据另行提交，不改写标签或已发布源码包。

### 0.4.0 后续验证：专注聊天与工作区文件（已随 0.5.0 发布）

2026-10-24，本机源码验证，不代表生产发布。原生与网页构建、TypeScript、ESLint / Prettier、clang-format、CTest 和 18 项 Vitest 通过。真实 Wrangler 与 Chromium、确定性模拟 Codex 的端到端回归验证：

- 桌面 1280×900、手机 390×844 聊天占满可用窗口、消息独立滚动、输入框可见且页面无横纵溢出；主机 / 项目、会话记录 / 详情默认隐藏，经菜单操作后显示。历史恢复、Markdown / 折叠工具、停止、审批、重新连接和设备撤销继续通过。
- 工作区文件菜单上传、下载 150003 字节二进制内容，分成多个 64 KiB 段后逐字节一致；默认覆盖被拒绝，明确确认后替换成功。目录中的符号链接未列出，关闭面板返回专注聊天。
- 文件接口拒绝未登录、CLI 角色、未授权主机、未注册项目、越界路径及超过 20 MiB 的上传请求。CTest 另外覆盖上传所有者 / 根目录隔离、只读下载 / 禁止上传、重复段一致性、未完成文件不可见、取消保留旧文件、目标变更阻止覆盖和下载版本冲突。

截图位于 `.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`、`.local/cw-chat-markdown.png`、`.local/cw-workspace-files.png` 和 `.local/cw-workspace-files-mobile.png`。本轮不调用模型；文件功能需同时升级网页、Worker 和 Agent。

### 0.4.0 后续验证：双向历史与客户端缓存（已随 0.5.0 发布）

2026-10-24，本机源码验证，未部署生产。原生 / 网页构建、TypeScript、ESLint / Prettier、clang-format、CTest、23 项 Vitest 和 Worker dry-run 通过；原生 TLS 回归覆盖可信 HTTPS / WSS、未知 CA 和错误主机名拒绝。

- CTest 覆盖 450 条历史分页、稳定游标与并发新增消息、消息版本补发、30 万字节中文内容逐块还原、内容版本冲突和会话隔离、负序号归档排序、长期保留及本机缓存读写 / 清理。Vitest 覆盖只读通道绑定认证会话、不占控制租约、非法指令拒绝、独立主动推送、旧版本不能覆盖新消息和 UTF-8 显示预算。
- 真实 Wrangler / Durable Object、原生 Agent / Client 与 Chromium 的完整端到端回归通过。确定性 Codex 夹具包含 510 条历史，最新十条各约 1 MiB、合计超过本地 8 MiB RPC 缓冲；验证恢复时排除完整 turns、每个本地 RPC 只读取一项、最新页优先、旧页按需读取、中文内容分块及已关闭会话读取尚未导入的历史。
- CC 经 Worker WebSocket 读取历史后写入按身份隔离的 SQLite，离线以相同参数读取缓存通过。CW 保存 IndexedDB 后，在测试主动阻断历史 WebSocket、主机 / 项目查询返回离线错误时，仍能恢复已缓存目录并显示会话内容；截图 `.local/cw-history-cache.png` 已目视检查。
- 既有登录 / 撤销、角色与主机隔离、去重、审批、独占控制 / 接管、原生 TUI 启动、断网重连、Markdown、移动布局及工作区文件回归均通过。Worker dry-run 仅打包，不上传或发布。

已与真实 Codex `0.164.0` 本地生成的协议 Schema 核对历史接口。本轮没有调用模型、读取真实用户超大历史或执行八小时长稳测试；会话总量不再触发自动清理，但磁盘、SQLite、单条本地 RPC、网络单帧与队列仍有各自限制，升级前已删除的数据不能恢复。CW 缓存恢复要求网页及中继认证仍可用，不代表完整离线 PWA。需要同时升级 Worker、网页、Agent 和 CC。

## 0.5.0 生产发布

2026-10-24 已发布至 `https://r.xlogic.cc`。Worker 版本 `e0178199-38a4-4794-a8bd-3a5274ece509`，部署记录显示 100% 流量；发布源码提交 `99e58901d120ffd6cf1658f457fdec2eb7bb0c95`，GitHub `master` 与 `v0.5.0` 标签已推送，远端标签指向该源码提交。此次同时发布此前未发布的专注聊天布局和工作区文件功能。

- Ubuntu 20.04、Debian 12 原生包及源码包的线上 SHA256 与发布清单、本机产物一致，下载清单版本为 0.5.0、提交与标签一致。两个发行版的下载程序均已在匹配系统执行 help；Debian 包内仅有 `coc-agent` / `coc-client` 两个运行程序。在线用户手册字节与源文件一致，响应头及 Chromium 实际字符集为 UTF-8。首页 / 健康检查正常，未登录业务返回 401、跨域管理登录返回 403。
- 真实 Chromium 管理页创建临时 A / CC Key，下载的 Debian 12 程序完成直接 Key 登录、CC 配对登录；CW Cookie 登录及刷新保留、管理员接口隔离和撤销后的 401 均通过。冒烟脚本最初沿用旧界面的可见控件定位，等待隐藏的主机框 / 尚未创建会话的输入框而超时；改用聊天工作区定位及功能菜单导航后，完整生产验证通过。
- 下载版 Agent 使用独立目录和确定性模拟 Codex 经生产 Worker 连接，验证 CW 原有历史恢复、发送任务和流式回复、Markdown / 工具折叠与菜单导航。新增 510 条历史场景通过生产只读 WebSocket 返回有界最新页、按游标读取旧页，以及 4096 字符中文内容块；浏览器 IndexedDB 已保存历史。下载版 CC 通过生产 Worker 读取 CLI 会话历史，随后从独立本机 SQLite 离线读取，内容一致。
- 只使用本次新建的临时设备 / Key 和项目，测试后已撤销临时授权并停止 Agent；未修改用户已有设备或调用模型。截图 `.local/cw-production.png`、`.local/auth-production.png`、`.local/api-key-production.png`。生产验证不代表八小时长稳、真实用户超大对话或 DO 休眠恢复验收。

已有远程主机和 CC 需要安装 0.5.0 原生程序，Agent 重启后才能使用新历史通道；本次未替用户更新已有主机上的服务。本节为发布后的证据补充，另行提交，不改写 `v0.5.0` 标签或已发布源码包。

## 0.5.7 外部会话验收

真实 Codex 0.164.0 的隔离 owner / reader 检查已通过：paginated / legacy、active writer 错误、只读反向游标、独立进程入队与 queue/list 一致。模型 provider 仅指向本地关闭端口，无真实模型调用。Linux CTest（Debian 容器）、77 项 Vitest、TLS、备份恢复、发布来源与更新器检查通过；格式、类型和生成协议检查通过。外部场景 E2E 已验证 paginated / legacy 增长快照、稳定 revision、相同请求去重、丢失应答后 queue/list 对账、不同内容拒绝、默认禁止入队、CC observe/history/queue/request、外部中断拒绝与安全断开。Chromium UI 回归验证桌面 / 手机布局、原有会话恢复与缓存流程；全量 E2E 和最终发行检查均已通过，发布证据见下文。

原生代码提交 `0458960` 的 [GitHub Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40195600279) 中 Windows x64 编译、CTest、启动和打包，以及 Linux sanitizers 已通过。最终发行提交重新运行三个 CI jobs；Windows 全程仅在 Actions 构建 / 测试，未在本地执行。真实 Codex 双进程测试在首次 paginated DB 初始化后启动 reader，避免上游首次建库竞态；只比较游标锚点身份，不依赖异步 turn 状态不变。真实模型执行和长期负载不在本次无模型验收范围；外部审批追加验证如下。

网页外部会话与运行中队列：[截图](assets/external-session-2026-10-25/desktop.png)。

### 0.5.7 无人值守审批追加验证

真实 Codex 0.164.0 共享 Unix app-server 验证原生桥接：原 owner 产生实际命令审批，新连接重放请求，由 C++ 原生客户端明确提交决定并接收解决通知，原 owner 继续存活。Responses provider 为本机确定性 stub，使用隔离 home / 项目，未读取用户凭据或调用真实模型。拒绝和批准分别验证不执行 / 仅执行无副作用 echo。集成回归增加 CC 审批命令、CW 审批界面、本轮精确权限、重复决定、原客户端先解决、错项目 / 未加载线程、不支持的交互及安全断开；发行源码 CI 和生产临时 fixture 均已通过，结果如下。

### 0.5.7 发布验收完成

- 源码 `94be403f37f842aaf968746984af59293d55efa7` 已合并并推送 master，标签 `v0.5.7` 指向该发行源码。[最终 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40200405588) 的 regression、sanitizers、windows-x64 全部通过，包括 Windows 本机 WebSocket 审批契约、CTest、启动检查及 ZIP 打包。Windows 全程未在本地构建或执行。先前一次 CI 在浏览器关闭后的控制权释放时序上超时，重连用例改为显式获取测试控制权，最终门禁已通过。
- 本地 Ubuntu / Debian CTest、77 项 Vitest、TLS、备份恢复、发布来源与更新器检查、类型 / 格式 / 生成协议和 Worker dry-run 通过。真实 Codex 0.164.0 的只读与队列测试覆盖两种历史模式；原生共享审批分别验证拒绝不执行和批准后继续执行临时项目中的无副作用 echo，原 owner 保持连接。未使用真实模型或用户 Codex 凭据。
- 2026-10-25 22:11（Asia/Shanghai）发布至 `https://r.xlogic.cc`；Worker 版本 `5f6b77c0-6a9b-47ca-be84-28c76112e0be`，部署 `1a2f1558-f9eb-40e4-a3cb-53ce5705d92f`，100% 流量。健康接口返回 0.5.7，未登录业务为 401，跨域登录为 403，首页安全头、新 JS / CSS 字节、手册 UTF-8 与源文件字节一致。
- Ubuntu 20.04 / Debian 12 / Windows x64 和源码四个在线归档 SHA256 与本机发行产物一致，version / commit / sourceDigest / protocol 一致；Windows 外层 Actions artifact 另与 GitHub 提供的 digest 核对。Linux 下载包实际执行身份与帮助检查；Windows 原生执行仅由对应 Actions job 验证。旧版直接下载地址保留，下载清单只列本次四个包。
- 生产验证使用实际下载的 Debian Agent、独立临时项目和确定性 Codex / 原服务 fixture，经真实 Worker 和 Chromium 验证 active-writer 降级、快照刷新、运行中入队、去重、请求查询、CW 显式审批、桌面 / 手机界面及安全断开。网页无运行时错误。验证后撤销本次临时请求 / 凭据，停止 Agent 并退出管理登录，未操作已有用户设备或调用真实模型。生产 fixture 验证不等同于在用户原有 Codex 进程中执行模型任务；真实 Codex 协议由上述本地隔离测试覆盖。

接入边界保持明确：远程审批需要原会话所属的共享 app-server；既有独占 stdio 进程不能事后转移审批。默认 `allowQueue / allowApprovals` 均关闭，需升级 Agent 并显式配置；不代替用户更新已有服务。命令 / 文件、本轮精确权限可远程处理，其他交互和设备身份验证仍受原客户端兼容性限制；真实硬件无人值守长稳、八小时压力等既有验收边界未扩充为已完成。

证据：[CI](assets/external-session-2026-10-25/actions-verification.json)、[部署](assets/external-session-2026-10-25/deployment.json)、[发行包](assets/external-session-2026-10-25/package-verification.json)、[在线资源](assets/external-session-2026-10-25/online-verification.json)、[线上流程](assets/external-session-2026-10-25/browser-verification.json)、[远程审批](assets/external-session-2026-10-25/production-external-approval.png)。本节为发布后的独立证据提交，不改写发行标签及源码包。

## Agent / CLI Codex 版本检查 · 2026-10-28

- `cmake --build build -j 2` 与 `ctest --test-dir build --output-on-failure` 通过；CTest 在允许本机套接字的沙箱外运行。原生回归覆盖接受较新 / 较旧版本、返回实际版本、拒绝空输出及版本命令非零退出，不调用模型。
- 修改的 C++ 文件通过 clang-format 检查，`git diff --check` 通过。本轮未运行 Windows 构建或跨版本真实 Codex app-server / TUI 验收。

### 0.5.13 发布与生产验证完成

- 发行源码 `99506d28bec9d97800b378c2e9f987a048ceceec` 与标签 `v0.5.13` 已推送；[Actions 40628265655](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40628265655) 的 regression、Ubuntu 20.04、Debian 12、musl、sanitizers、Windows x64 和 publish-release 全部通过。覆盖原生回归、浏览器集成、计费通讯、TLS、更新器、类型、格式及协议检查；无真实模型调用。
- [GitHub Release](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.13) 提供四平台包、源码和站点。下载站点核对独立 asset digest，五个归档同时匹配清单 SHA256 与 GitHub asset digest；版本、提交、sourceDigest、protocol 与干净源码一致，源码包与标签的 git archive 字节一致。实际解包的 Ubuntu / musl Agent 和 CLI 均通过构建身份及 help 启动检查；Windows 原生执行由 Actions 验证。
- Worker `30cb4797-bec0-40fa-81df-67f510ae617a` 于 2026-10-28 UTC 03:56:17 部署，部署 ID `c7bf97cc-36ed-4a08-bbe7-b39ea96cf5a9`，生产流量 100%。使用 `--keep-vars`，沿用生产配置、secrets 和 DO 数据；0.5.12 旧归档按部署前线上校验和验证后保留。
- 线上健康接口返回 0.5.13 / demand 1 / protocol 1，未登录业务请求 401、跨域管理登录 403。首页 CSP、JS / CSS、UTF-8 手册、下载清单与校验文件均核对通过；重新下载生产的五个新归档，与已验证产物逐字节一致。
- 本轮发布下载包及站点，不直接替换已有用户 Agent / CLI 服务，未发送管理员版本通知或操作真实设备、会话。现有程序升级到 0.5.13 后获得新版本检查行为；取消版本号限制不代表所有 Codex 版本的 API 均已验收。

证据：[Actions](assets/release-0.5.13/actions-verification.json)、[产物](assets/release-0.5.13/package-verification.json)、[部署](assets/release-0.5.13/deployment.json)、[线上核验](assets/release-0.5.13/online-verification.json)。本节为发布后的证据提交，不改写发行源码、标签或归档。

## Access 准入职责分离 · 2026-10-29

- 线上短时诊断确认：Access 放行的请求到达 Worker 时仅含签名 assertion，原始 Client ID / Secret 头均缺失；原有 Worker 二次校验因此返回 `ACCESS_SERVICE_REJECTED`。诊断仅输出请求头名称，不记录到公开文档中的凭据。
- 按用户要求移除 Worker 对共享 Token JSON、环境变量与机器 Client 头的依赖。保留 JWT 签名、issuer、AUD、时间校验与邮箱关联；无邮箱机器请求仍须通过 CoC API Key / 设备授权。新增回归覆盖缺失 Client 头的机器登录、无邮箱权限边界、签名邮箱提取，以及 Client 头不影响邮箱识别。
- 本地 124 项 Vitest、类型检查与 lint 通过；生产部署须等待本次源码提交的全部 CI 必需作业完成，部署与线上验证另行记录。

## 原生 Access 环境覆盖 · 2026-10-29

- 共享原生初始化支持 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` 成对覆盖文件及内置凭据，保留可信 origin 列表且不写回配置。C++ 回归覆盖文件 / 内置覆盖、单字段、空值、换行与 origin 隔离；原生 HTTPS/WSS 测试使用不同的文件值及环境值，确认请求实际采用环境值。
- 本地 124 项 Vitest、类型检查、lint、C++ 格式检查与原生构建通过；CTest native-core（39.34 秒）及真实本机 HTTPS/WSS / TUI 桥接环境覆盖验证通过，不调用模型。生产部署仍须等待对应源码的全部 CI 必需作业。

## 项目共享入口凭据更新 · 2026-10-29

- 用户明确授权提交 `config/cloudflare-service-token.json` 并要求修改 `AGENTS.md`：豁免只覆盖此文件中的共享 Access 入口凭据及可信 origin，不覆盖 CoC API Key、所有者密钥、会话凭据或其他文件。CI 后续原生构建内置新 Secret；Worker 已移除该配置依赖。文档不记录具体值。
- 取消此前源码提交的本地自动部署等待，改为等待包含轮换值的新提交全部 CI 必需作业通过。

## Access 准入职责分离最终验收 · 2026-10-29

- 发布源码 `1d22f4562e376fafbf979b184638900f15bf7e35`，[Actions 40815244914](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40815244914) 六项必要作业全部成功，包括原生环境覆盖和浏览器 Access 回归。Worker / web 产物摘要、提交、源码摘要均通过部署脚本检查。
- Worker 部署并删除两个废弃 Access Secret 后，健康接口返回 200，首页及资源与已验证 CI 产物逐字节一致；无邮箱入口身份被邮箱 API 拒绝（403），无效 CoC API Key 被登录接口拒绝（401）。`OWNER_SECRET` 保留。未以真实浏览器重复管理员登录验收，未替换远端原生程序，未发布新原生下载包。
- 证据：[部署与鉴权矩阵](assets/access-admission-2026-10-29/deployment.json)。凭据配置豁免由用户明确授权，仅覆盖项目共享配置文件；文档和证据不复制实际密钥值。

## CW 邮箱登出与访客入口验证 · 2026-10-29

- CW 菜单在存在邮箱身份时显示“登出”，固定跳转到用户指定的 Cloudflare Access logout URL。真实 Chromium 覆盖中英文、精确跳转、无邮箱隐藏、管理员模式隐藏，并继续通过原有邮箱授权恢复及管理员登录检查；退出目标由测试拦截，未访问线上 logout。截图保留在忽略目录 `.local/browser-access/email-sign-out.png`。
- `/guest` 保留查询参数并跳转到 `/guest/`；资源、API 和 WS 均走访客前缀。浏览器检查确认访客请求没有落到普通 `/assets/`、`/api/` 或 `/ws/`。访客 Cookie 名称和路径与普通入口隔离，不关联邮箱授权。
- Worker / Registry 回归覆盖免邮箱配对、内部邮箱要求标记不可从普通入口伪造、Cookie 作用域、无凭据拒绝、跨主机隔离、角色权限、CSRF、WS 授权及撤销。`/downloads` 前缀默认公开，普通 API 仍要求 Access。
- `npm run test:access:web` 已在现有本地测试容器中完整通过：除浏览器检查外，真实 workerd 在普通入口启用 Access 时完成访客资源加载、公开下载、CoC 配对、真实配对通知与主机 WS 订阅；撤销凭据后 WS 以 4001 关闭，后续请求返回 401。使用隔离存储、临时测试凭据，无模型调用或生产请求。
- 最终 135 项 Vitest、类型检查、lint、网页构建及 `git diff --check` 通过。开发阶段未修改线上 Access 策略；随后按下节完成提交、CI 与部署。生产访客及下载路径的既有边缘规则已由匿名请求验证可以到达 Worker。

## CW 访客入口最终部署验收 · 2026-10-29

- 源码 `a99c36b3b1a90b6987594db94cbfc5b5900027e3` 已提交并推送；[Actions 40822368692](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40822368692) 六项必需作业全部成功，包括新增访客 workerd 集成与邮箱登出 Chromium 检查。使用经过摘要和来源核验的 CI 产物部署，Worker 版本 `d076bdd2-96a5-4b3b-b219-fe9242caecd1` 接收 100% 流量。
- 线上 13 项匿名请求验证通过：`/guest` 查询参数重定向、访客 HTML / JS / CSS、公开下载清单 / 校验和 / 手册与 CI 暂存内容一致；访客邮箱接口返回 `enabled: false`，缺少 CoC 授权的 hosts、管理、身份和 WS 请求返回 401 `UNAUTHORIZED`；普通 API 继续受 Access 保护。发布 JS 包包含指定登出地址，健康检查通过。
- 未在线执行真实邮箱登录 / 登出或生产 CoC 配对；这些流程由上述隔离浏览器 / workerd 集成覆盖。保留原有原生下载包、生产配置和 DO 数据，未重启 Agent / Client，未调用模型或更改边缘 Access 策略。
- [完整部署与匿名请求证据](assets/guest-cw-2026-10-29/deployment.json)。记录为部署后文档提交，不改变已部署源码及产物身份。
