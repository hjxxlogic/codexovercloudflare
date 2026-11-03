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

发布前必须核对待使用的状态是否符合当前格式：SQLite 结构完整且 `user_version` 为 `0` 或 `1`、项目目录含完整日志、浏览器 `commandAccounting:2`，DO 到期索引完整（`expiryMigration` 不存在或 `pending:false`）。本项目不提供旧库迁移或配置别名转换；有效无邮箱网页授权保留显式认领入口；不满足时返回格式或升级错误，部署脚本不转换这些业务状态。结构完整的未标记库直接读取，不修改版本；缺列的库不自动升级。具体错误见用户手册。

## 当前线上版本

Worker、网页与当前线上 Linux Agent 为 `0.6.7`，目标为 `https://r.xlogic.cc` 与既有 systemd 用户服务。本次按明确授权使用未提交源码本地构建，GitHub Actions 跳过，无 Actions URL，`ciVerified=false`、`dirty=true`；不作为 CI 验证发行制品。活动会话重启获得了明确授权，配置与 SQLite 已备份，安装后完成 120 秒连接验证。

| 构建或制品           | 身份 / SHA256                                                      |
| -------------------- | ------------------------------------------------------------------ |
| 构建基准 commit      | `c3ffef94afd3bd09c0598df2d19aa0697b463d0c`                         |
| 构建时源码摘要       | `1057fdcd349956a6c3dc51d9d1940e2bb10a416ae212bb33bb9058e69cbaee9c` |
| Worker Version ID    | `17d8ac2e-c840-40ed-a944-f04966a8d953`                             |
| Worker bundle SHA256 | `7defb0533db96f974ffabdb0565d5eb878c849cdb5dee671015c5cb7a3f273aa` |
| 网页入口 SHA256      | `e41265b8bdaa83376b019a669a8fbfe47455ab119975e11dfd45e78206b2a961` |
| 运行 Agent SHA256    | `7c8e0ce89098be2d25cad05a222fdf2e35434f7b954549b296e30360487ea368` |

当前验证覆盖真实 Access 邮箱登录与授权恢复、主机版本和在线状态、邮箱专属目录、旧会话历史、Codex 线程目录、Terminal WebSocket 命令与输出、旧 HTTP 字节操作拒绝、真实模型回复、刷新后历史和草稿恢复、任务不重复提交、文件上传 / 侧栏与新窗口预览 / 下载的字节一致性。测试会话已结束，测试文件已清理；107 条原有会话记录保留，原 SQLite 版本标记仍为 `0`，配置仅移除废弃的 `autoUpdate.intervalHours`。

本地 CTest 11/11、Vitest 492/492、部署工具 35 项检查通过。69 个线上静态资源与准备制品逐字节一致。构建源码快照、详细日志、浏览器截图和机器证据位于忽略的 `.local/deployment-0.6.7/`，来源摘要以部署时快照为准。

本次保留下载站原有安装包：Linux 和源码为 `0.6.6`，Windows 为 `0.6.5`；Windows 包未部署，也未发布更新通知。其它 Agent 不在本次升级范围。
