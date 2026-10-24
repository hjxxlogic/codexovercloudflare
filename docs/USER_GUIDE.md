# 用户手册

> 0.3.0 开发预览版。生产中转 R：**https://r.xlogic.cc**；本机开发地址：`http://127.0.0.1:8787`。下载：[原生程序和源码](https://r.xlogic.cc/downloads/)。

## 1. 组件与权限

| 简称     | 组件                                | 职责与凭证范围                                                 |
| -------- | ----------------------------------- | -------------------------------------------------------------- |
| R        | Cloudflare Worker / Durable Objects | 登录审批、授权校验、撤销、中转                                 |
| A        | `coc-agent`                         | 代表自己的主机，运行 Codex 服务端                              |
| CC       | `coc-client`                        | 一份凭证仅访问一个指定 A 的客户端功能                          |
| CW       | 网页 Codex 客户端                   | 一份浏览器凭证仅访问一个指定 A 的客户端功能                    |
| 管理身份 | 网页管理入口                        | 审批 A / CC / CW 登录、查看和撤销设备；不能直接操作 Codex 会话 |

只有两个本地程序，不再提供原来的 `coc`。A、CC、CW 使用相同的设备授权机制。每份授权独立，绑定角色和设备；CC / CW 额外绑定目标 A。不同角色的凭证不能互换。CC 控制 CLI 模式会话，CW 控制网页模式会话。

每次登录申请有效 5 分钟。批准后领取的设备凭证没有固定到期时间，直到 R 撤销。不要把配对码当作凭证；只有发起申请的程序或浏览器能够领取对应授权。管理员需核对申请方提供的配对码、设备名称、角色和目标 A，避免批准陌生请求。

CC 在本地文件保存多份凭证；CW 为每个 A 保存独立的持久化 HttpOnly Cookie，可切换 A 及其会话。浏览器对 Cookie 有存储期限限制，网站在使用时续写；浏览器清理、隐私模式退出或长期未访问导致 Cookie 丢失时仍需重新申请。R 不会因设备离线、程序重启或关闭页面自动撤销授权。

## 2. 安装与前置条件

当前原生发行包支持 Linux x86_64，分别提供 Ubuntu 20.04 和 Debian 12 动态链接包。选择匹配的发行版，下载并核对 `SHA256SUMS`，解压后安装：

```bash
sudo install -m 0755 coc-agent coc-client /usr/local/bin/
```

只运行服务器时只需安装 `coc-agent`；用户电脑只需安装 `coc-client`。运行原生程序不需要 Node.js。系统需要对应版本的 OpenSSL、Boost.System、SQLite3、libstdc++ 和 CA 证书；用 `ldd coc-agent` / `ldd coc-client` 检查动态库。

A 必须安装并配置 **Codex 0.164.0**，以运行 Agent 的系统用户确认 `codex` 可以正常使用。使用 CC 的电脑同样需要 Codex 0.164.0 来运行原生 TUI；CW 用户不需要安装 Codex。模型凭据、代码和命令执行留在 A 上；模型 API Key 不用于 R 登录。

从源码开发时：

```bash
npm ci
npm run build:native
npm run setup:local
npm run dev
```

开发需要 Node.js ≥22.17、C++17、CMake ≥3.16、Boost.System ≥1.71、OpenSSL、SQLite3、nlohmann/json ≥3.7。Ubuntu 20.04 的 workerd 容器方案见 [开发说明](DEVELOPMENT.md)。以下示例的 R 地址在本机体验时替换为 `http://127.0.0.1:8787`。

## 3. 管理网页

打开 R 网站，点击“管理员登录”，输入所有者密钥。本地开发密钥在 `.local/owner-secret`；生产使用独立密钥，不能分发给客户端。管理员会话有效 8 小时，与长期设备凭证分开。

“设备授权管理”展示待授权请求的设备类型、名称、目标 A、配对码及有效期；核对后批准或拒绝。请求页面会自动刷新。已授权设备列表可单独撤销凭证，不显示秘密凭证。A 授权后可将它的 A 标识提供给需要连接的用户。

管理员登录本身不授予 A 访问权；要在同一浏览器使用 Codex，点击“连接 A”，另外申请 CW 授权。

## 4. 运行 A

在服务器上申请自己的登录，同时创建项目配置：

```bash
coc-agent login --relay https://r.xlogic.cc --name build-server \
  --config ~/.config/coc-agent/agent.json \
  --project /srv/projects/my-project --project-id my-project
```

终端显示管理网页地址和配对码。将请求交给管理员，在网页核对并批准。程序自动领取 A 专用凭证，写入权限为 `0600` 的配置文件，并输出 A 标识。无需安装 CC 或生成登记码。

```bash
coc-agent status --config ~/.config/coc-agent/agent.json
coc-agent run --config ~/.config/coc-agent/agent.json
```

出现 `Agent connected` 后即可供授权客户端使用。默认配置路径为 `~/.config/coc-agent/agent.json`，可通过 `--config` 或 `COC_AGENT_CONFIG` 指定。已有非空凭证时拒绝再次登录，避免意外覆盖身份。首次登录必须提供 `--project`。

配置示例见 [agent.example.json](../examples/agent.example.json)。可在 `projects` 数组增加项目，每项包含唯一的 `id`、显示名 `name` 和真实绝对路径 `path`；客户端只能选择已配置项目，不能指定任意路径。`codexPath`、`codexArgs` 和 `sandbox` 由服务器配置，客户端不能修改。重启 Agent 后配置生效。

每个 `dataDir` 只能运行一个 Agent。先前台确认运行正常，再参考 [systemd 模板](../examples/coc-agent.service) 设置实际运行用户、HOME、Codex PATH 和配置路径。A 只建立出站 WSS，不要将 Codex app-server 直接暴露到公网。

## 5. 使用 CC

从管理员取得目标 A 标识，然后申请访问：

```bash
coc-client login --relay https://r.xlogic.cc --host A_ID --name my-laptop
```

终端显示授权网页地址和配对码；管理员批准后自动登录。再次为另一个 A 执行登录会保留原凭证。同一个 R / A 在本地保存一份当前凭证，重新登录会替换本地记录，R 中的旧授权仍需管理员单独撤销。

```bash
coc-client hosts
coc-client use --host A_ID
coc-client status
coc-client projects
coc-client connect --project my-project
coc-client sessions
coc-client stop A_ID~SESSION_ID
```

`hosts` 仅查询本地已授权的 A，各 A 使用自己的凭证；失效授权单独显示错误，不影响其他 A。登录成功后默认选中新 A；`use` 持久保存默认选择，也可在每条命令传 `--host A_ID`。同名主机或跨 R 选择不明确时，使用 A 标识并追加 `--relay`。

`connect` 创建 CLI 会话并启动本地 Codex TUI。代码和命令运行在远程 A 的项目中。当前尚不支持重新附着已有 CLI runtime；`attach` 会返回明确的限制错误，先检查原任务状态，不要盲目重发。

默认凭证文件为 `~/.config/coc-client/credentials.json`，权限 `0600`，可通过 `--config` 或 `COC_CREDENTIALS` 指定。不要复制到其他设备或提交 Git。

## 6. 使用 CW

1. 打开 R 网站，在“连接指定 A”输入 A 标识和设备名称，点击“申请登录”。
2. 将页面上的配对码和请求信息交给管理员核对并批准；原页面自动完成登录。
3. 选择在线 A 和项目，点击“创建网页会话”，输入文本任务并发送。
4. 查看流式回复、工具事件和代码差异；遇到命令或文件审批时检查详情并明确允许或拒绝。
5. 使用“停止本轮”中断当前轮次，使用“结束会话”关闭 runtime。

点击“添加 A 授权”可登录另一个 A，已有授权保留；下拉列表仅展示本浏览器已授权的 A。刷新或重新打开浏览器后，可选择原 A 与网页会话，恢复保留的历史和当前状态。不同标签页可以选择不同 A，R 根据请求目标选择对应 Cookie，不依赖全局当前凭证。

秘密凭证不放入 URL 或 JavaScript 本地存储；HttpOnly Cookie 对页面脚本不可读。CW 不能通过改写 A 标识访问其他主机，也没有审批设备登录的权限。

回复按持久事件序号排序、去重后拼接。网页只支持文本输入和命令 / 文件审批；其他补充问题或 MCP elicitation 会明确拒绝，不隐式同意。CLI 与网页会话不能跨模式控制。

## 7. 本地退出、撤销与恢复

本地删除凭证：

```bash
coc-client logout --host A_ID
coc-agent logout --config ~/.config/coc-agent/agent.json
```

CW 选择 A 后点击“移除本地授权”。这些操作只删除本地保存的凭证，**不撤销 R 上的授权、不停止任务**。清除 A 的本地凭证前先单独停止常驻 Agent；运行中的进程可能仍持有原凭证。

真正停用设备时，在管理网页撤销对应凭证：

- 撤销 CC / CW：拒绝后续请求，并关闭使用该凭证的连接；其他客户端授权继续有效。
- 撤销 A：禁用主机，使其全部 CC / CW 授权失效，并关闭主机及相关客户端连接；Agent 收到撤销码后停止本地会话并退出。
- 需要重新接入时重新申请并批准登录；A 重新登录会产生新主机标识，客户端需要针对新 A 重新授权。

撤销不回滚已经发生的代码修改，也不保证所有外部进程已退出，需要时在服务器检查。最多 5 台有效的新协议 A；撤销后的记录不占有效主机配额。

## 8. 断线与当前边界

| 情况                    | 行为                                     |
| ----------------------- | ---------------------------------------- |
| 网页短暂断线            | 自动重连，先同步再允许发送               |
| A 网络断线              | 退避重连，Codex runtime 不立即退出       |
| 客户端持续离线          | 默认保留 runtime 30 分钟，随后中断并关闭 |
| 审批无人响应            | 默认等待 10 分钟，随后拒绝               |
| Agent 重启 / Codex 退出 | 原活动会话标记失败，目前不能恢复旧线程   |
| 提交后结果不明          | 不自动再次执行，先检查原会话与文件       |

每个 A 最多 4 个活跃 runtime；同项目默认一次只执行一个轮次。网页事件默认保留 7 天，受约 1 GiB 配额影响可能提前清理。单帧最多 256 KiB，尚无大消息分片。代码和模型凭据保留在服务器，但 Cloudflare 可见中转内容，目前没有端到端加密或不可信多用户的系统级隔离。

## 9. 从 0.2.x 升级

这是不兼容的认证升级，需同时更新 R、网页及原生程序。

1. 安装 `coc-agent` / `coc-client`，移除旧 `coc`；将 systemd 启动命令改成 `coc-agent run --config ...`。
2. 旧的 8 小时客户端凭证、旧 Agent 令牌和旧管理员 Cookie 不再接受；所有者密钥保持不变。
3. 停止旧 Agent，备份配置和数据目录；用 `coc-agent logout --config ...` 清除旧配置中的令牌，然后用 `login --config ...` 重新申请。项目与 dataDir 保留，A 标识改变。
4. CC 使用新的多授权凭证文件；旧 `~/.config/coc/credentials.json` 不自动导入。CW 对每个新 A 单独申请。
5. 原 `enroll`、`agent-enroll`、客户端 `revoke`、验证码兑换接口退出支持，统一使用网页审批和撤销。

SQLite 会话 / 事件格式不变；每个 dataDir 只运行一个 Agent。旧活动会话在重启时标记失败，不能假装恢复原进程。

## 10. 排错

登录申请过期或被拒绝时重新申请；核对目标 A 是否存在、已授权且未撤销。短期频繁申请会限流。看不到项目时检查 A 配置、目录权限；主机离线时检查进程、WSS、凭证和 Codex 版本。GLIBC 问题参见容器方案，不要替换系统 libc。

报告问题提供时间、主机 / 会话 ID、版本和错误码，不提供令牌、所有者密钥或模型凭据。已测范围及未完成验收见 [测试记录](TEST_REPORT.md)。
