# Cloudflare Access 与 CoC 邮箱授权

## 实现状态

本功能已在工作区实现，尚未部署或启用线上 Access。未配置 `ACCESS_ENABLED=true` 时保留原有 CoC 登录方式。原生程序的共享 Service Token 默认值已从项目配置编译入二进制；启用 Worker Access 模式仍需配置团队域名、应用 audience 和管理员邮箱，并在 Cloudflare 配置对应策略。

本项目使用以下认证规则：

- 只有浏览器用户通过 Cloudflare 验证邮箱；已验证邮箱关联数据库中的全部 Agent（A）网页授权，换浏览器后自动恢复，无需重新配对或输入连接 Key。
- 所有 `coc-agent`、`coc-client` 以及项目运维工具使用同一组 Service Token，免邮箱登录通过 Access。Agent / CLI 的实际权限仍由各自的 CoC API Key 或设备凭据控制。
- 配置的管理员邮箱自动获得 owner 管理权限；其他邮箱用户输入正确的 `OWNER_SECRET` 后也可进入管理。
- Service Token 准入完全由 Cloudflare Access 策略控制。Worker 验证 JWT 签名、issuer、audience 和时间后，仅按有效邮箱关联用户 Key / 主机授权；无邮箱请求继续使用 CoC API Key / 设备凭据鉴权。Worker 不导入、不保存、不校验项目 Service Token。

## 项目共享 Service Token

[config/cloudflare-service-token.json](../config/cloudflare-service-token.json) 仅供 Agent、CLI 和运维工具使用，Worker 不导入此配置。按项目要求，该 Token 随源码保存，定位为免邮箱验证的项目入口凭据；CoC API Key、所有者密钥、用户会话凭据仍按原有私密凭据规则管理。

配置包括：

| 字段           | 用途                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| `origins`      | 原生程序和运维工具允许发送 Token 的 HTTPS origin 列表，当前默认项目中继域名 |
| `clientId`     | 共享 Cloudflare Service Token 的 Client ID                                  |
| `clientSecret` | 同一 Service Token 的 Client Secret                                         |

CMake 调用 [build-access.py](../scripts/build-access.py) 生成 C++ 常量头文件。Agent / CLI 运行时无需读取源码文件或额外安装凭据文件。网页和 Worker 构建均不导入此配置。修改后只影响原生程序和运维工具；更新已运行的原生程序凭据无需发布 Worker。

HTTP 请求、WebSocket 初次握手与重连均发送：

```http
CF-Access-Client-Id: <项目共享 Client ID>
CF-Access-Client-Secret: <项目共享 Client Secret>
Authorization: Bearer <对应的 CoC 凭据或短期票据>
```

保留 CoC 的 `Authorization`，不能让 Access 的单请求头模式占用它。API Key 登录、配对开始等接口继续使用原有请求体格式，不要求预先拥有设备 Bearer。[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

### 原生程序覆盖配置

一般连接项目默认中继不需要额外参数。测试、独立部署或轮换时可以用完整配置文件覆盖编译默认值：

```json
{
  "origins": ["https://relay.example.com"],
  "clientId": "<CLIENT_ID>",
  "clientSecret": "<CLIENT_SECRET>"
}
```

使用 `--access-config /absolute/path/access.json`，或在 Agent / CLI 配置中设置 `cloudflareAccessFile`。未指定文件时也可用 `COC_ACCESS_CONFIG`；优先级为命令参数、程序配置、环境变量、编译默认值。`login` 成功后保存所用文件的绝对路径，后续命令和服务重启复用；其他命令的参数只覆盖本次运行。

自定义文件在 Linux 必须由运行用户拥有且无组 / 其他用户权限（通常为 `0600`），Windows 应使用当前用户私有目录和 ACL。无效文件、缺少字段、非法请求头字符或非 HTTPS origin 均报错。Token 只发送到精确匹配协议、主机和端口的 origin，不发送到代理 CONNECT、其他 Relay、外部唤醒地址或第三方下载站。

HTTP 控制、配对订阅、异步回执、Agent 上行、历史连接及下载更新共用此配置。CLI 配置 Access 的目标即使没有网络代理，也会使用 loopback `TuiBridge`；Codex TUI 仅取得短期 CoC 票据，由桥接添加 Access 请求头。

## Worker 配置与 Cloudflare 策略

| Worker 变量               | 说明                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `ACCESS_ENABLED`          | `true` 开启 JWT 校验及邮箱关联；缺省或 `false` 保留旧部署模式                 |
| `ACCESS_TEAM_DOMAIN`      | 固定团队 issuer，例如 `https://your-team.cloudflareaccess.com`，不带末尾斜杠  |
| `ACCESS_AUD`              | 此 Access 应用的 audience tag                                                 |
| `ADMIN_EMAIL`             | 唯一自动获得管理权限的邮箱；不配置则只支持管理员密钥登录                      |
| `OWNER_SECRET`            | 继续保留原有管理员密钥，至少 32 字符，供其他邮箱管理登录及 owner 会话版本校验 |
| `ACCESS_PUBLIC_DOWNLOADS` | `true` 仅豁免 `/downloads`、`/downloads/` 子路径的 Worker Access 校验         |
| `ACCESS_PUBLIC_HEALTH`    | `true` 仅豁免 `/api/v1/healthz` 的 Worker Access 校验                         |

团队 issuer、audience 缺失或格式错误时，启用模式拒绝受保护请求，不自动降级。管理员邮箱格式错误也会报告配置错误。邮箱匹配保留 local-part 大小写并将域名转小写；管理员配置应使用 Access 返回的邮箱形式，不合并点号或 `+` 别名。

Cloudflare 侧采用 **hostname-based Access** 应用，覆盖网页、API 和 WS。当前 Worker-level Access 不支持 WebSocket；本项目不使用该保护模式。[官方限制](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

在同一应用中配置浏览器 `Allow` 策略（One-time PIN）和允许项目共享 Token 的 `Service Auth` 策略。浏览器后续 API / WS 复用 Access Cookie；机器请求使用 Service Token。两者共用路径，不能把整个 `/api/*`、`/ws/*` 设置为仅浏览器或仅机器可用。这里的“跳过 Access”表示 Service Auth 免交互放行，不是对业务接口配置无条件 Bypass。

浏览器 Allow 可以限制指定邮箱 / 邮箱域，也可明确选择 `Include → Login Methods → One-time PIN` 允许所有验证邮箱进入申请页面。验证邮箱本身不会授予任意 A 权限。管理员邮箱也必须通过这层策略。[Access 策略](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

`wrangler.jsonc` 已设置 `run_worker_first: true`，让静态资源也经过 Worker 校验；`workers_dev` 与预览 URL 继续关闭。下载、健康检查若选择公开，Cloudflare 边缘例外和 Worker 变量必须一致。否则更新、部署和监控应携带共享 Token。

Worker 优先使用 `Cf-Access-Jwt-Assertion` 校验 RS256 签名、固定 issuer、audience、Token 类型和有效期；仅在请求头不存在时，读取唯一的 `CF_Authorization` Cookie 并执行同一套校验。重复应用 Cookie、超长 Token 和无效签名均拒绝；已有但无效的请求头不能通过 Cookie 回退绕过。Worker 不校验共享 Token；仅从已验证 JWT 的邮箱 claim 建立用户身份，无邮箱时不建立邮箱关联。认证错误只返回固定失败阶段（`token / keys_* / key_id / signature / claims / identity`），不返回 Token、邮箱、预期配置或底层异常。JWKS 来自固定团队证书地址，使用 Worker 支持的 `redirect: manual` 并显式拒绝非成功响应，不跟随重定向；缓存五分钟；未知 key 可触发刷新，间隔至少三十秒。不会使用未验证 JWT 中的地址取钥。Static Assets 内部路由不传递 `ctx.access`，因此不依赖 `ctx.access.getIdentity()`。[JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Static Assets 限制](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

附加的邮箱 Header 不能建立用户身份，只有已验证 JWT 中的有效邮箱 claim 才用于关联用户 Key / 主机授权。没有邮箱时不授予用户或管理员权限；机器 API Key / 设备凭据继续决定角色、主机与撤销状态。Client 请求头是否存在不参与 Worker 鉴权。

## 邮箱与 A 授权持久化

状态保存在已有 SQLite 后端的 `RegistryDO`，沿用 `ctx.storage` 键值 API 和事务，无需新建数据库：

| 记录                              | 内容                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `emailAccount:<accountId>`        | 可信 issuer、规范化邮箱、账户 ID 和创建时间；账户 ID 由 issuer 与邮箱摘要确定     |
| `emailGrant:<accountId>:<hostId>` | 邮箱、目标 A、授权代次、批准来源、有效状态及时间                                  |
| `auth:<凭据摘要>`                 | 浏览器独立 `web` 凭据的账户和授权代次，或带登录来源 / 管理员配置版本的 owner 会话 |

“A 连接 KEY”在这里表示邮箱对 A 的持久网页访问授权。数据库不保存可取回的 Agent / CLI Key 明文，不把能登记主机或批准请求的 `agent` Key 发给网页。Registry 继续只保存长期凭据摘要。

### 首次批准与新浏览器恢复

1. 浏览器完成 Cloudflare 邮箱登录，Worker 根据已验证用户身份读取账户与全部有效 A 授权。
2. 首次访问尚未授权的 A 时申请 CW 配对。Worker 绑定可信邮箱，管理员页面和 Agent 待审批信息显示该邮箱。指定 A 的申请由对应 Agent 或管理员批准；未指定时由管理员选择 A。
3. 领取时事务复核申请秘密、邮箱、批准结果和主机状态，再建立持久邮箱授权。未领取申请过期不会留下永久授权，用户填写的名称 / 留言不能决定邮箱归属。
4. 换浏览器后，同一邮箱可直接看到全部有效 A，包括离线 A。选择 A 时自动恢复该浏览器独立的 `coc_web_<hostId>` HttpOnly Cookie；无需重新申请或输入 Key。恢复凭据有效期为 30 天，邮箱授权自身持续到撤销。
5. 网页请求和 WS 握手必须同时匹配当前 Access 邮箱、CoC web 凭据、授权代次、目标及主机状态。会话仍使用原有 attach 票据、模式、控制权和审批规则。

**新浏览器没有有效 Access 会话时仍需验证邮箱**；免除的是重复 CoC 配对。每个邮箱的恢复 / 迁移接口最多每分钟 60 次，避免无限生成浏览器凭据。列表通过初始化、可见性恢复、选中主机通知或显式刷新更新，不增加后台高频轮询。

### 撤销与旧浏览器迁移

管理页“已授权设备”按邮箱与 A 显示持久授权；撤销该条目会使此邮箱访问该 A 的全部浏览器凭据失效并关闭匹配连接。其他邮箱与其他 A 的授权保留。撤销 Agent 会级联停用该 A 的邮箱授权，新 Agent 不自动继承旧身份。

“断开当前浏览器连接”清除该 A 的本地 Cookie，不撤销邮箱的持久授权；再次选择时可以恢复。当前已有的旧网页 Cookie 没有邮箱归属，页面提供“关联旧授权”按钮，用户明确确认后在事务中认领到当前邮箱。同一旧凭据不能被其他邮箱再次认领。没有旧凭据时仍须首次批准。

跨浏览器恢复的是授权关系，不同步 IndexedDB 历史、草稿或偏好。更换邮箱时清除页面上旧账户的选中状态与对话，后续缓存仍按 CoC 身份隔离。

## 管理员邮箱

经过 Access 验证的邮箱与 `ADMIN_EMAIL` 匹配时，网页自动调用服务端取得或复用 owner 会话，显示管理功能，无需输入管理员密钥。其他邮箱默认只能使用自己的 A 授权，输入正确 `OWNER_SECRET` 后可进入管理；这不会修改 `ADMIN_EMAIL`。

owner 仍使用独立的 `coc_admin` HttpOnly Cookie、八小时期限和服务端撤销检查。管理 API 与 `/ws/v1/admin` 核对当前邮箱归属，不能拿上一邮箱的 Cookie 为新邮箱管理。管理员邮箱配置改变使旧的自动管理会话失效；管理员密钥登录会话按独立来源处理。密钥轮换继续使已有 owner 会话失效。

退出管理结束当前会话；同次页面不会立即自动登录回来，可显式选择“使用管理员邮箱进入管理”。重新打开页面时仍按管理员邮箱配置自动登录。未配置管理员邮箱不自动将第一个用户设为管理员。

owner 管理权不直接替代网页会话控制权。管理员要操作某个 A 的 Codex 会话，需批准自己的邮箱对该 A 的网页授权。配置变化后的已有订阅在后续服务端验证 / 通知时关闭，不承诺无活动连接立即感知配置变化。

## API 与运维接入

新增 API（均在 `/api/v1` 下）：

| 路径                       | 用途                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `GET /auth/email`          | 返回当前邮箱、是否为配置的管理员、可迁移的旧授权；未启用 Access 返回 `enabled: false` |
| `POST /auth/email/admin`   | 管理员邮箱自动登录 / 复用管理会话                                                     |
| `POST /auth/email/restore` | 传 `hostId`，恢复当前邮箱已授权 A 的网页 Cookie                                       |
| `POST /auth/email/migrate` | 传 `hostId`，将当前浏览器持有的有效旧网页凭据认领到当前邮箱                           |
| `GET /hosts`               | 邮箱模式下从数据库列出有效 A，不要求新浏览器已有各 A Cookie                           |
| `POST /admin/revoke`       | 继续支持旧设备凭据；邮箱授权 ID 则撤销该邮箱对 A 的全部派生凭据                       |

公开配对 ID 不能替代申请秘密；`/api/v1/auth/device/events` 仍是需要申请秘密且核对账户的 WebSocket。原生 API Key 登录、设备配对、角色 / 目标验证和撤销机制继续保留。

[deploy-agent.py](../scripts/deploy-agent.py) 与 [deploy-cloud.py](../scripts/deploy-cloud.py) 的下载 / 验证共用 [cloudflare_access.py](../scripts/cloudflare_access.py)，默认读取项目配置，可用 `COC_ACCESS_CONFIG` 覆盖。仅向匹配 origin 发送 Token，通过 curl 标准输入传请求头，不写入命令行。带凭据请求不跟随重定向，拒绝登录 HTML 被当作清单 / 安装包；GitHub API 和第三方产物下载不携带项目 Token。

先部署兼容代码、配置原生程序，再开启业务域名 Access；不要让旧程序在无法重连时也无法下载升级。共享 Token 轮换只需协调 Cloudflare Service Auth 与各原生程序；Worker 不保存或校验该 Token，轮换无需更新 Worker。撤销单个设备使用 CoC 凭据撤销，不撤销全项目 Token。

发布仍遵循 [RELEASE.md](RELEASE.md)：使用同一提交全部必需 Actions 作业成功后的产物，Agent 等待空闲并保留配置 / 数据库，Worker 发布单独执行。实现和本地测试不等于已经上线或完成真实 Access 边缘联调。

## 验证

- `npm test`：JWT 签名和字段拒绝、无原始 Client 头的机器 API Key 登录、无邮箱权限隔离、伪造邮箱、跨邮箱隔离、首次领取、跨浏览器恢复、管理员邮箱 / 密钥登录、配置变更、授权撤销及旧凭据迁移。
- `npm run test:tls`：实际原生 HTTPS/WSS、代理 CONNECT 不携带 Token、证书校验、无网络代理的 TUI 桥接、非可信 origin 不发送 Token、登录 HTML 拒绝。
- `npm run test:access:web`：两个新浏览器恢复邮箱 A 列表、管理员邮箱自动进入管理、其他邮箱输入密钥管理；使用合成身份，真实 JWT 授权在服务端测试中验证。
- 部署前仍需用真实 Access 应用验证用户 / Service Auth 策略、转发到 Worker 的请求头、静态资源、Token 过期 / 轮换及 WS 重连。当前未使用线上凭据执行这些集成操作。

测试结果与平台限制见 [TEST_REPORT.md](TEST_REPORT.md)，用户操作见 [USER_GUIDE.md](USER_GUIDE.md)。
