# 发布操作

## 制品与来源

正式制品由 `.github/workflows/checks.yml` 构建。推送干净源码后，等待准确提交的完整 Actions 成功，逐项检查 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64。本地构建用于开发，不能替代已验证发行制品。

发行包含 Worker、网页、在线手册、Ubuntu 20.04 / Debian 12 动态包、Linux x86_64 musl 静态包、Windows x64 ZIP 与源码。包内只提供 `coc-agent` / `coc-client`。版本、提交、源码摘要、协议和归档 SHA256 必须一致。

匹配 `package.json` 的 `v` 标签在全部门禁通过后运行发布作业；`scripts/assemble-release.py` 核对各平台来源和 SHA256，组装下载目录及 GitHub Release。Actions 不持有 Cloudflare 凭据，不自动发布生产 Worker。

## 发布云端

使用已提交脚本准备、核验和部署；不要以手工拼接命令替代其保全及校验。

```bash
# 只准备：等待 CI、下载、验证制品和现有下载站
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID

# 发布同一运行的 Worker / 网页，保留现有原生下载
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID --apply

# 同时发布同一提交的四平台下载
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID --publish-downloads --apply
```

四个平台制品使用独立文件并行下载，各自核对摘要后才组装发布目录。公开仓库下载较慢时可追加 `--gh-proxy`，通过 GH-Proxy 下载公开 Actions 制品；先匿名确认仓库公开，不向代理发送 GitHub / Cloudflare 凭据，仍以可信 GitHub API 返回的 SHA256 验证。私有或无法确认公开的仓库拒绝使用代理。

脚本校验完整 Actions 门禁、GitHub artifact 摘要和干净来源，以 CI 保存的配置上传 Worker / 网页；发布前后保全并逐包校验下载站。线上网页、脚本、样式、手册、清单、校验和及健康接口需要核对。

只支持 RegistryDO / HostRelayDO 原生存储，保留现有 namespace、class migration 和数据；不提供数据库后端切换或迁移接口。默认保留线上普通变量；确需让配置替换普通变量时使用 `--replace-vars`，先确保配置列全仍需变量，Secret 保留。不要因默认域名而推断获准部署。

共享 Access Token 轮换需更新原生程序与 Cloudflare Service Auth；Worker 不保存此 Token。`OWNER_SECRET`、CoC Key 和设备凭据继续保密。入口与策略见 [Access 说明](cloudflare-access-coc-auth.md)。

需要通知自动更新时，在全部下载验证后加 `--notify-release --owner-secret-file /absolute/private/owner-secret`。通知只触发检查，不代表 Agent 已安装；安装仍等待空闲。需要删除已废弃 Secret 可显式重复 `--delete-secret NAME`。下载快照恢复可使用 `--preserved-downloads /absolute/path/downloads`，仍须逐包 SHA256 校验。

## 独立 r2 测试站

`--target r2` 固定使用 `codex-over-cloudflare-r2` 与 `r2.xlogic.cc`，两个 DO 类仅绑定这个 Worker 的独立 namespace；不修改默认 `wrangler.jsonc` 或旧站路由。r2 必须明确指定新 Access 应用的 `--r2-access-aud AUD`，或经授权选择 `--r2-without-access`（仅 CoC 身份与权限）。不沿用旧站 AUD 或 owner secret。

首次部署须准备权限为 0600 的独立 owner secret 文件，并用完整 CI 制品初始化下载站：

```bash
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID \
  --target r2 --r2-access-aud AUD --publish-downloads --initialize-downloads \
  --initialize-owner-secret-file /absolute/private/r2-owner --apply
```

仅 Worker / 网页配置中的目标与 Access audience 按显式参数选择；业务代码和四平台包仍必须来自同一完整成功的 Actions。首次初始化只用于新站，后续省略两个 `--initialize-*` 参数以保全原有下载和 Secret；r2 的证据、缓存均与默认目标分开。

线上测试复用本地加密端到端套件，固定请求 r2，启动一个临时独立 Agent，使用临时配置、SQLite 和项目，结束时只撤销测试授权并停止自己的子进程：

```bash
npm run test:opaque -- --online-r2 \
  --agent /absolute/verified-ci/coc-agent \
  --owner-secret-file /absolute/private/r2-owner
```

r2 部署脚本的在线检查还需设置 `COC_ACCESS_CONFIG=/absolute/private/r2-access.json`，使私有配置明确允许 `https://r2.xlogic.cc`。它与浏览器测试的 `--access-config` 分别传递，默认生产配置只允许旧站 origin；不要改写生产配置或把入口凭据发送到其他域。

Access 开启时另传 `--access-config /absolute/private/r2-access.json`，文件须包含 r2 精确 origin 与获准用于该入口的 Service Auth 凭据；原生 Agent 经主入口验证，测试浏览器的 HTTP / WebSocket 同样携带机器入口凭据且仅放行 r2 域请求；网页设备配对测试走现有 `/guest/` 入口，不将 Service Auth 冒充邮箱用户，邮箱登录须另行验证。测试不会安装二进制、调用 systemd 或读取既有 Agent 数据。结果和桌面、手机截图写入忽略的 `.local/r2-deployment/`；模拟 Codex 不调用模型。

## 部署 Linux systemd 用户服务 Agent

```bash
# 默认只准备，不改变服务
python3 scripts/deploy-agent.py --commit HEAD \
  --ssh ubuntu@server --binary /opt/coc/coc-agent

# 推送干净 HEAD、等待完整 CI 和目标空闲，再备份安装与验证
python3 scripts/deploy-agent.py --push --commit HEAD \
  --ssh ubuntu@server --binary /opt/coc/coc-agent --apply
```

当前脚本支持公开 GitHub 仓库的 linux-musl Agent 制品；目标需要 Python 3、现有 systemd 用户服务和日志权限，执行端需要 Python 3、curl、SSH/SCP 及可用认证。TLS 与 SSH 主机校验保持启用。项目 remote 名为 github 时可指定 `--push-remote github`，仍校验 URL、不 force-push。

本机用户服务用 `--local` 代替 `--ssh`。`--service` 默认 `coc-agent.service`；`--binary` 必须为 MainPID 对应的现有绝对路径。默认等待 CI 2400 秒、空闲 1800 秒；指标缺失、过期或存在 runtime / 历史读取 / 文件请求不能当作空闲。

脚本检查准确提交及所有必需作业，验证 GitHub artifact SHA256、包内校验和和候选程序 version / commit / sourceDigest / protocol / clean。安装前备份实际运行的 `/proc/MainPID/exe`，原子替换后默认观察 120 秒，检查 PID、运行来源、Relay 握手和连接错误；失败尝试回滚。配置、凭据、SQLite 和备份保留，不替换 CLI。

空闲检查是近期指标快照，不能与新任务形成原子互斥；部署窗口应停止提交新任务。重启活动会话必须明确授权 `--allow-restart-active`。Agent 更新不包含 Worker 发布或 GitHub Release 授权。

本机 Agent 与 CLI 同步部署可在 `scripts/deploy-agent.py --push --push-remote github --local --binary /absolute/path/coc-agent --apply` 增加 `--client-binary /absolute/path/coc-client`。该选项仅接受 CI 产物及已有本机 CLI：先完成 Agent 空闲等待、安装和连接验证，再从同一份已校验摘要的 CI 归档提取 CLI，核对源码身份，备份并原子替换；现有 CLI 进程继续使用原 inode，新命令使用新版。CLI 验证失败尝试恢复备份；若 Agent 已成功而 CLI 失败，命令返回错误，需按部署证据分别核实，不将两者视为原子事务。

## 配套升级与回退

Relay / 网页先部署，再让新版原生程序连接；业务只接受 `delivery:2`，Terminal 要求 Agent 上报 `streaming:2`。配置、凭据、项目目录与历史独立备份，保留未知请求身份，不导入不兼容缓存任务。稳定 Agent 身份和请求准入代次分别处理，不能因更新或过期自动重放副作用。

运行实例不会因下载包已发布而自动完成升级。Linux 按自动更新策略等待会话和读取结束；Windows 停止程序后手动替换整包，保留配置和状态。

回退前停止实例、备份当前状态并核对升级后的副作用。新存储不能直接交给不兼容二进制；需要匹配整套组件及一致备份。项目登记权威为 `dataDir/projects.json`，不应使用配置内的初始化数组覆盖当前目录。SQLite 恢复不恢复 Codex 进程或项目文件，见用户手册的备份操作。

## 显式例外与证据

只有用户明确授权跳过 CI 时，才使用 Agent 的 `--local --local-build` 或云端 `--local-build`；默认仍要求干净 HEAD，校验构建来源、备份、空闲和验证，记录 `ciVerified=false`，不能作为 CI 验证发行包。若用户同时明确要求不提交源码，可加 `--allow-uncommitted`；仅允许本地构建，保留真实 `dirty=true`、基准 commit 与完整源码摘要，构建前后源码身份必须相同。不会执行提交、推送或 Actions；现有下载保留，Agent 部署仍等待空闲并支持回滚。

云端 `--cloud-only-after-windows-failure` 只用于用户明确要求的分阶段发布：运行已完成、Windows 为唯一必需失败项、其余全部成功，保留下载且不通知更新。`--skip-native-platform linux-musl` 同样只用于明确批准的暂缓平台，保留其已验证下载并标注限制，不把部分发行冒充完整发行。

部署工具可在干净后继提交使用修复后的工具发布祖先提交 CI 制品，分别记录部署工具与代码来源；不得重新本机构建冒充既有制品。

机器证据默认在 `.local/deploy-cloud/`、`.local/deploy-agent/`。完成实际部署后，按仓库要求记录准确 commit、Actions URL/结果、artifact/包摘要、目标、验证和限制；私有配置与凭据不写入公开记录。源码现状、下载版本和正在运行版本分别核对。

## 运行状态格式

发布前必须核对待使用的状态是否符合当前格式：SQLite 结构完整且 `user_version` 为 `0`、`1` 或 `2`、项目目录含完整日志、浏览器 `commandAccounting:2`，DO 到期索引完整（`expiryMigration` 不存在或 `pending:false`）。本次支持结构完整的 SQLite 0/1 单向迁移到 2，不提供配置别名转换；有效无邮箱网页授权保留显式认领入口；不满足时返回格式或升级错误，部署脚本不转换这些业务状态。新版写入端将结构完整的 0/1 库升级到 2；缺列的库不自动升级，旧版程序不能读取升级后的库。具体错误见用户手册。

## r2 仅更新网页

已有明确的本地预览授权时，可用已验证的 r2 `deployment.json` 保留线上 Worker 执行制品，只重建网页：

```bash
COC_ACCESS_CONFIG=/private/r2-access.json python3 scripts/deploy-cloud.py \
  --local-build --target r2 --commit HEAD \
  --r2-access-aud R2_ACCESS_AUD \
  --web-only-from .local/deploy-cloud/PREVIOUS-r2/deployment.json --apply
```

Cloudflare 将代码和静态资源绑定为一个版本，因此仍产生新部署版本。此模式复用原 Worker 制品和配置，保留线上变量、Secret、原生下载及下载说明 / 主题。发布前后回读可执行模块并核对 SHA256；规范化的 source map 不计入执行代码校验。支持主站和 r2 `--local-build`，要求历史部署证据与显式目标一致，拒绝变量替换、Secret 删除、首次初始化、原生发布与更新通知；分别记录 Web 与 Worker 来源，`ciVerified=false`。前后端接口必须兼容。

## 历史发布证据与当前边界

最初的 0.6.14 合并阶段只验证与准备制品；后续用户已授权主站发布和网页更新，实际身份见 [主站部署记录](PRODUCTION_OPAQUE_DEPLOYMENT.md)。下列历史记录属于各自日期与提交。

2026-11-07 主站 0.6.15 已使用准确提交 `54e210c` 的完整成功 CI 制品发布；Worker / 网页、四平台下载、线上摘要和测试提速结果见 [0.6.15 发布记录](RELEASE_0.6.15_2026-11-07.md)。

| 历史范围                         | 源码、验证与证据                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r2 初始不透明中继及后续 Web 预览 | 初始 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`、[Actions 41764690561](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 六项成功；后续预览有 `ciVerified=false`。逐次版本、SHA、包摘要和限制保留于 [r2 历史记录](R2_DEPLOYMENT.md)。                                                                                                                                                                      |
| 2026-11-05 原 master 0.6.7       | `a1fc79f3a80e74ee8310739bd4d69934ab48e331`、[Actions 41961015104](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41961015104) 六项成功；云端、四平台下载与本机 Agent 的摘要和核验见 [部署证据](assets/release-0.6.7-2026-11-05/deployment.json)。原始过程和完整 SHA256 表见 [固定 master 发布记录](https://github.com/hjxxlogic/codexovercloudflare/blob/7c344413607becd70444341882951844a6e72dbd/docs/RELEASE.md)。 |
| 2026-11-04 本地构建发布          | `589c26b45ed62c74c8610b26fbc48f9b1c42f4e5` 与 `ddb83cb6637b8a8ef56a40e0e7793d96e2b189b8` 均按当时明确例外发布，`ciVerified=false`；Agent 安装及离线实例限制见上述固定记录与 [事故记录](INCIDENT-2026-11-04.md)。                                                                                                                                                                                                                    |
| 2026-11-06 只读历史恢复          | `a4e2b2b11548bf684bd96102bbffbcf7c1daf9e5` 含 `9580dcb`，仅本地构建 Worker / Web，`ciVerified=false`，未更新 Agent。Cloudflare ID `a103c4dd-f5b8-4a82-a19d-3329129339b5`；来源、文件摘要与检查范围保留于上述固定 master 记录。                                                                                                                                                                                                      |

历史生产浏览器验证、离线主机或当时尚未安装的候选包均保留原限制；不将它们记为本轮验收。准确提交 CI 与本轮制品来源见 [测试报告](TEST_REPORT.md)。

## 不透明中继的状态迁移准备

本次 0.6.14 仅集成与验证，不执行云端、下载、Agent 更新或 tag 发布。生产操作仍须完整执行 OPAQUE_RELAY_MERGE_PLAN.md 第 7 节。

HostRelayDO 的首次访问迁移沿用 namespace/object identity；每批至多 64 键，以同一事务写入 `~opaque-v1:backup:<旧键>`、读回验证、删除旧键并推进 `~opaque-v1:cursor`。wakeUntil 保留原键并备份；完成后标记 channelVersion=1 与 complete，取消旧 alarm。旧连接全部退休，旧 lease/ticket/项目写锁不能恢复资格。租约 active、存在 pending 控制预留或权限操作 pending 时拒绝该批；不得通过手工改完成标记绕过未决副作用核对。RegistryDO 不转换身份、主机、授权、撤销、到期与失效重试键，其现有 alarm 继续负责重试。

迁移备份仅供受控恢复：发布窗口必须导出并核对旧对象状态及未决请求，禁止将备份交回旧 Worker 后直接开放写入。未访问对象首次访问也须完成迁移。只有相应对象完成且实际业务验证通过后才能登记为已验收。本次没有线上存储枚举、快照导出或生产迁移证据。

旧状态映射以 `666d1af` 为准：

| 对象 / 旧状态                                                              | 迁移规则                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Registry `@doState`、`host:*`、`auth:*`、device / API Key / 邮箱与主机目录 | 原值及对象身份保留，继续沿现有授权路径读取                                               |
| Registry `auth-change:*`、到期索引与 alarm                                 | 保留失效事件与重试，不在 Host 迁移中清理或扩大授权                                       |
| Host `wakeUntil`                                                           | 原键保留，并写入隔离备份；中断后仍有冷却边界                                             |
| Host `lease:*`、`project-writer:*`、`ticket:*`、`session-mode:*`           | 租约 active 或 pending 时拒绝迁移；确认旧控制退休后备份并删除，新 Agent 自行建立控制状态 |
| Host `permission-operation:*`、`permission-wire:*`、`due:*`                | 任何非 completed 操作阻止对应批次；已核对终态连同索引备份并退休，不向新业务重放          |
| Host `agentEpoch`、`revision`、`@doState` 及其余旧键                       | 全部逐键备份并退休，不作为新端点代际或日志                                               |
| 旧 WebSocket attachment 与 Host alarm                                      | 迁移前退休旧连接；失败仍不放行业务，成功取消旧 alarm，新连接重新准入                     |
| `~opaque-v1:*`、`channelVersion`                                           | 新的隔离备份、游标与完成标记；未知版本拒绝，不能手工篡改为完成                           |

上述为首次访问懒迁移，不假设跨 DO 全局事务。未决状态须在发布窗口用旧版本完成、取消或与 Agent 账本核对后退休；本次没有实现跳过这些检查的强制入口。失败后可在同一对象重试，后续离线对象也按此规则处理。

## 0.6.14 r2 本地预览与数据库验证

用户明确授权在 Actions 后台运行期间，用干净源码 `fd53702` 本地构建并发布 r2；`ciVerified=false`，保留已有下载 / 独立 Access / Secret / DO。线上健康、静态资源字节和隔离加密业务验收通过，原站及两既有 Agent 未变，见 [r2 发布记录](R2_DEPLOYMENT.md)。功能验收源码 `d4a3f4e` 的 [六项必需 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42171580611) 随后全部成功；这不改变 r2 部署的本地制品来源。制品摘要与 CI Agent 隔离验收见 [证据](assets/opaque-integration/ci-artifacts.json)。

用户允许 Agent 重新登录，仅要求数据库可迁移，因此不复制生产 DO 或旧 Token。真实数据库通过在线备份 API 生成副本，另复制后用真实 Store 离线完成 0→2 升级并核对所有原表；不替换原数据库或重启服务。新站登录和数据库目录必须使用独立配置 / 副本，不能让两个 Agent 共享 dataDir，也不能将原生产 Agent 的 relayUrl 改成测试站。

主站仅更新网页使用 `python3 scripts/deploy-cloud.py --local-build --target production --web-only-from .local/deploy-cloud/PREVIOUS/deployment.json --apply`。必须使用此前已验证且当前执行模块仍一致的主站证据；不能使用 r2 证据。原生下载从主站读取并保留，不安装或重启 Agent。

## 显式跳过 CI，仅发布本地 Linux 下载

仅在用户明确要求时使用；需要干净源码提交与相同身份的静态 musl 构建。不会触发 Actions，不会安装或重启 Agent，也不发送更新通知：

```bash
python3 scripts/deploy-downloads.py \
  --deployment .local/deploy-cloud/PREVIOUS/deployment.json \
  --local-build-dir build-musl-release
# 检查生成的 deployment.json 和下载包后，使用相同参数追加 --apply
```

脚本复用已验证的线上 Worker / 网页，前后核对 Worker 模块摘要，只更新下载资源。Linux 三个入口使用同一份完全静态 musl 二进制，保留原 Windows 包；下载清单标记 `localBuild=true`、`ciVerified=false` 和 Windows 的旧版本 / 来源。制品仍校验源码身份、静态 ELF、SHA256 与发布后的在线字节，不能称为 Actions 验证发行。
