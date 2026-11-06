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

## 当前线上版本

独立测试站 `https://r2.xlogic.cc` 的 Worker / 网页及下载包为 `0.6.7`，源码为 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`。该准确提交的六项必需 CI 作业全部成功，使用经过来源与摘要校验的 CI 制品部署，`ciVerified=true`。线上健康、静态资源、下载包及隔离端到端验证通过，详见 [r2 部署记录](R2_DEPLOYMENT.md)。

本次仅部署 r2。旧站 `r.xlogic.cc` 和既有本机 Agent 保持独立，未由此升级；两者运行身份不能从 r2 版本推断。测试 Agent 为临时进程，测试后停止并撤销授权。

### r2 仅更新网页

已有明确的本地预览授权时，可用已验证的 r2 `deployment.json` 保留线上 Worker 执行制品，只重建网页：

```bash
COC_ACCESS_CONFIG=/private/r2-access.json python3 scripts/deploy-cloud.py \
  --local-build --target r2 --commit HEAD \
  --r2-access-aud R2_ACCESS_AUD \
  --web-only-from .local/deploy-cloud/PREVIOUS-r2/deployment.json --apply
```

Cloudflare 将代码和静态资源绑定为一个版本，因此仍产生新部署版本。此模式不编译 Worker，复用原 Worker 制品和原配置，保留线上变量、Secret、原生下载及下载说明 / 主题。发布前后从 Cloudflare 读取线上可执行模块并与原制品核对 SHA256；Wrangler 会规范化调试 source map，因此 source map 不计入执行代码不变校验。只允许 r2 `--local-build`，拒绝变量替换、Secret 删除、首次初始化、原生发布与更新通知；Web 来源和保留的 Worker 来源分别记录，`ciVerified=false`。仅适用于前后端接口兼容的网页变更。
