# 用户手册

> 0.5.2 开发预览版。生产中转 R：**https://r.xlogic.cc**；本机开发地址：`http://127.0.0.1:8787`。下载：[原生程序和源码](https://r.xlogic.cc/downloads/)。

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
mkdir -p "$HOME/.local/bin"
install -m 0755 coc-agent coc-client "$HOME/.local/bin/"
export PATH="$HOME/.local/bin:$PATH"
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

### 原生程序自动更新

从 0.5.2 起默认启用自动更新。Agent 运行期间每小时检查配置中 `relayUrl` 的 `/downloads/`；下载和候选检查在后台进行，等所有运行会话结束且没有历史读取后才关闭连接、释放数据库锁并原地重启，沿用原启动参数。空闲检查最多约 30 秒一次；保持附着但未执行任务的会话仍算运行会话，须结束会话后才切换。CLI 在成功的业务命令结束（TUI 退出）后检查，安装后下一次启动生效，不会在 TUI 运行中替换进程。help、version、doctor、logout 和离线历史读取不触发自动检查。

在 Agent 的 `agent.json` 或 CLI 的 `credentials.json` 顶层加入以下配置即可禁止自动下载和安装，既有凭据字段保持原样：

```json
{ "autoUpdate": false }
```

也可设置 `{"autoUpdate":{"enabled":true,"intervalHours":24}}`；间隔为 1–168 小时，默认 1 小时，失败也按间隔退避。Agent 每 30 秒重读这一设置，CLI 下次命令读取。关闭后不发起新检查并丢弃待安装结果，已经发起的下载可能完成。CLI 首次登录前若要禁用，可预建 `{"version":2,"entries":[],"selected":"","autoUpdate":false}`；没有现有 Agent 配置时，首次登录后、运行前设置。

自动匹配 Linux x86_64 / Ubuntu 20.04 或 Debian 12；兼容衍生系统需明确设置 `autoUpdate.platform` 为 `ubuntu20.04` 或 `debian12`，不会猜测 ABI。检查来自所连接中继，CLI 优先 `--relay`，否则选中主机的中继；无选中主机时使用默认地址。不向下载接口发送设备凭据，不跟随重定向，不降级或安装预发行版本，要求协议主版本一致。开发脏构建不自动更新。

程序和安装目录必须归运行用户所有、目录可写且没有组/其他用户写权限；拒绝 set-ID 程序。建议安装到该用户的 `~/.local/bin`，并让 systemd 使用相同路径。root 所有的 `/usr/local/bin` 安装不会让普通用户自动提权更新，需管理员手动安装，或改为用户目录。更新依赖系统 `/bin/tar`；无需 Node.js，不更新 Codex、系统动态库、配置、凭据或数据库。

每次安装验证归档 SHA256、候选程序 `--version` 的版本/提交/源码摘要/目标/协议及干净身份，保留权限并原子替换当前程序；旧文件保存为同目录 `<程序名>.previous`，仅保留上一版。校验失败、权限不足或网络失败会向 stderr 输出更新错误，自动检查不使当前业务命令失败。此校验依赖中继 HTTPS 和下载服务可信，不是独立发布签名。管理员仍须检查新发行版兼容性。

可以显式执行以下命令立即检查（不受自动开关和间隔限制），无需重新登录：

```bash
coc-client update --config ~/.config/coc-client/credentials.json
coc-agent update --config ~/.config/coc-agent/agent.json
```

运行中的 Agent 手动更新后须自行重启服务；自动更新会自行重启。需要回退时先停 Agent 或退出 CLI，将 `.previous` 文件替换回原程序后重新启动，并配置 `autoUpdate: false` 防止再次升级。程序回退不回退数据库或工作区；跨版本数据兼容性与备份要求见 [发布说明](RELEASE.md)。0.5.1 及更早程序没有自动更新功能，首次升级仍须手动安装 0.5.2。

## 3. 管理网页

打开 R 网站，点击“管理员登录”，输入所有者密钥。本地开发密钥在 `.local/owner-secret`；生产使用独立密钥，不能分发给客户端。管理员会话有效 8 小时，与长期设备凭证分开。

“设备授权管理”展示待授权请求的设备类型、名称、目标 A、配对码及有效期；核对后批准或拒绝。请求页面会自动刷新。已授权设备列表可单独撤销凭证，不显示秘密凭证。A 授权后可将它的 A 标识提供给需要连接的用户。

管理员登录本身不授予 A 访问权；要在同一浏览器使用 Codex，点击“连接 A”，另外申请 CW 授权。

### API_KEY 登录（与配对审批并行）

管理员可在“API Key 管理”输入名称并选择使用程序：`coc-agent` 或 `coc-client`。创建 CC Key 必须同时选择目标 A，创建后不能修改角色或目标。A Key 首次使用时创建并绑定自己的 A，之后使用同一个 Key 总是返回该 A，不会重新创建或改绑。未使用的 A Key 不占主机配额。

完整 Key 仅在生成后显示一次；请立即复制保存，列表只显示名称、角色、绑定 A 和创建时间。API_KEY 本身就是访问凭证，不用于换取另一份长期密钥。持有 Key 即可访问其限定功能，不绑定某台电脑或安装实例。它与配对审批得到的独立凭证并行，均长期有效直到 R 撤销。

登录时增加 `--api-key`，程序会隐藏终端输入；也支持通过标准输入或 `COC_API_KEY` 环境变量提供。不要将 Key 作为命令行参数，以免留在命令历史或进程列表中。

```bash
# 按提示输入 A Key；首次仍需配置项目
coc-agent login --api-key --relay https://r.xlogic.cc --project /srv/projects/my-project
# 输入 CC Key；--host 必须与管理员创建 Key 时选定的 A 一致
coc-client login --api-key --relay https://r.xlogic.cc --host <A-ID>
```

登录后原样将 API_KEY 保存到原有 `0600` 配置文件，后续 `run`、`status`、`connect` 等命令无需再次输入。无人值守时可由秘密管理服务注入 `COC_API_KEY`，登录完成后移除环境变量。共享 Key 的多个程序共用同一身份，撤销会影响所有持有者；需要独立撤销时请分别生成 Key。

管理员在网页撤销 Key 后，已有连接立即关闭；撤销已绑定的 A Key 会停用对应 A，并使其全部 CC / CW 授权失效。已授权设备列表中撤销同一身份效果一致。未使用的 A Key 也可撤销。本地 `logout` 仅删除本地副本，不撤销 R 中的 Key。原有配对审批登录方法继续支持，0.3.0 设备凭证无需重新登录。

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

1. 打开 R 网站，在“连接远程服务器”输入 A 标识和设备名称，点击“申请登录”。
2. 将页面上的配对码和请求信息交给管理员核对并批准；原页面自动完成登录。
3. 从顶部“历史”或“功能菜单 → 会话记录”打开会话面板，在顶部“连接设置”选择在线 A 和项目；点击“创建网页会话”开始。以后可通过菜单中的“新建对话”开始，或打开“会话记录”恢复本地历史。
4. 聊天区区分你的消息和 Codex 回复，支持 Markdown 标题、列表、表格、代码块和链接；工具输出、计划、代码差异与状态默认折叠，点击展开。遇到命令或文件审批时检查详情并明确允许或拒绝。
5. 执行中在输入框旁点击“停止本轮”；通过“功能菜单 → 会话详情”查看连接状态、项目和会话 ID，或执行结束会话、重新连接 / 接管。

顶部“功能菜单”提供会话记录、新建对话、工作区文件、会话详情、CW 对话、设备授权与 API Key；菜单打开后约 4 秒自动收起（键盘焦点仍在菜单内时保留），移出菜单、选择功能或按 Escape 也会收起。已登录时，主机 / 项目选择、刷新主机、新建会话、添加 A 授权、移除本地授权及管理员登录统一位于“会话记录”面板顶部的“连接设置”，下方展示会话列表，无需另开设置页。未登录时通过“登录与授权”进入登录操作；设备和 Key 管理需要管理员身份。

聊天输入使用 Enter 发送，Shift + Enter 换行；中文输入法确认候选时不会发送。执行中禁止重复发送，可停止本轮。消息自动跟随新输出，向上查看历史后暂停跟随，回到底部恢复。聊天区在桌面和手机均占满可用窗口，消息独立滚动、输入框保持可见；聊天时不显示主机 / 项目选择、会话列表、状态详情、快捷键说明或页脚。菜单中的“会话记录”和“会话详情”按需打开弹窗，选择会话后自动关闭；也可用“关闭”、Escape 或点击遮罩返回聊天。审批、执行中断和连接异常仍直接显示，防止遗漏必要操作。

通过“功能菜单 → 工作区文件”浏览当前主机所选项目的目录。点击目录进入，或用“上级目录”返回；普通文件可下载到浏览器。上传时先选择本地文件，可修改“保存为”的相对路径；父目录须已存在。默认禁止覆盖，确需替换时勾选“覆盖已有文件”并确认。单文件上限 20 MiB，支持二进制文件和空文件；目录列表每页 100 项，点击“加载更多文件”继续。暂不支持上传整个目录、创建目录或打包下载目录。

文件操作使用已授权 CW 凭证和 Agent 配置的项目根目录，不依赖活动对话或模型。只读 Agent 允许浏览和下载，禁止上传；路径不能越出项目，也不跟随符号链接。上传先写临时文件，全部完成后才发布，覆盖前重新核对目标是否变化；下载期间文件变化会报错，应重新下载。点击“取消传输”或关闭面板会中止当前传输，已完成的文件保留；断网或 Agent 强制退出时结果可能不明，先刷新目录检查。未完成上传会在 10 分钟无操作后清理；强制终止 Agent 遗留的 `.coc-upload-*` 临时文件需停机后人工清理。浏览和下载会显示项目中运行用户可读的普通文件（含隐藏文件），应只授权可信设备，并谨慎选择包含凭据的项目。此功能需要同时更新网页、Worker 和原生 Agent。

会话列表读取 A 运行用户的同一 Codex home，按更新时间展示当前项目的非归档交互会话，与该用户本地 Codex 共用历史；可搜索已加载的标题 / 摘要并“加载更多”。其他项目、其他系统用户、其他 Codex home 和归档线程不会混入。网页选择已有活动 CW 会话时重新附着；关闭 / 失败或原生 Codex 历史线程会创建新 CW runtime，恢复原 threadId 及对话内容，并强制使用 A 的项目目录、sandbox 和用户审批策略。仍在 CLI runtime 使用的线程须先结束原会话；不要同时在原生 Codex 和 CW 修改同一线程。

在“会话记录”顶部的“连接设置”点击“添加 A 授权”可登录另一个 A，已有授权保留；下拉列表仅展示本浏览器已授权的 A。刷新或重新打开浏览器后，可选择原 A 与网页会话，恢复保留的历史和当前状态。不同标签页可以选择不同 A，R 根据请求目标选择对应 Cookie，不依赖全局当前凭证。

秘密凭证不放入 URL 或 JavaScript 本地存储；HttpOnly Cookie 对页面脚本不可读。CW 不能通过改写 A 标识访问其他主机，也没有审批设备登录的权限。

回复按持久事件序号排序、去重后拼接。网页只支持文本输入和命令 / 文件审批；其他补充问题或 MCP elicitation 会明确拒绝，不隐式同意。CLI 与网页会话不能跨模式控制。

## 7. 本地退出、撤销与恢复

本地删除凭证：

```bash
coc-client logout --host A_ID
coc-agent logout --config ~/.config/coc-agent/agent.json
```

CW 在“会话记录”顶部选择 A 后点击“移除本地授权”。这些操作只删除本地保存的凭证，**不撤销 R 上的授权、不停止任务**。清除 A 的本地凭证前先单独停止常驻 Agent；运行中的进程可能仍持有原凭证。

真正停用设备时，在管理网页撤销对应凭证：

- 撤销 CC / CW：拒绝后续请求，并关闭使用该凭证的连接；其他客户端授权继续有效。
- 撤销 A：禁用主机，使其全部 CC / CW 授权失效，并关闭主机及相关客户端连接；Agent 收到撤销码后停止本地会话并退出。
- 需要重新接入时重新申请并批准登录；A 重新登录会产生新主机标识，客户端需要针对新 A 重新授权。

撤销不回滚已经发生的代码修改，也不保证所有外部进程已退出，需要时在服务器检查。最多 5 台有效的新协议 A；撤销后的记录不占有效主机配额。

## 8. 断线与当前边界

| 情况                    | 行为                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| 网页短暂断线            | 自动重连，先同步再允许发送                                                       |
| A 网络断线              | 退避重连，Codex runtime 不立即退出                                               |
| 客户端持续离线          | 默认保留 runtime 30 分钟，随后中断并关闭                                         |
| 审批无人响应            | 默认等待 10 分钟，随后拒绝                                                       |
| Agent 重启 / Codex 退出 | 原活动会话标记失败，可从 CW 本地历史恢复持久线程；原进程与未完成任务不会自动继续 |
| 提交后结果不明          | 不自动再次执行，先检查原会话与文件                                               |

每个 A 最多 4 个活跃 runtime；同项目默认一次只执行一个轮次。会话历史不再按总量或时间自动清理，实际容量取决于 Agent 磁盘；升级前已清理的数据不会自动恢复。单帧最多 256 KiB、网络队列最多 8 MiB，单条本地 Codex RPC 仍受约 8 MiB 缓冲限制；这些是单次处理限制，不是会话总大小限制。代码和模型凭据保留在服务器，但 Cloudflare 可见中转内容，目前没有端到端加密或不可信多用户的系统级隔离。

### 大会话与客户端缓存

Agent 保存权威历史。Cloudflare Worker / Durable Object 只认证和双向转发，不保存历史正文。打开会话先取得最新一页（最多 200 条、正文约 96 KiB）；向上滚动到消息区顶部附近时自动异步加载更早内容，也可点击“加载更早内容”；读取期间显示加载状态并阻止重复请求，失败或断线后可重试。加载结果完整合并旧消息并保留阅读锚点，连续加载会累积显示所有已加载消息，不再按 400 条或 192 KiB 裁剪。在线读取和读取本地缓存的行为一致，加载越多占用的浏览器内存越多。“返回最新内容”回到有条数和字节上限的实时窗口，旧内容可以重新读取。超长内容显示读取按钮，每次最多读取 4096 个 Unicode 字符；“展开更多”累积读取，窗口最多保留最近约 128 Ki 字符并明确提示截断，避免一次加载全部输出。执行和审批通过原有控制连接进行，读取历史不取得控制权。

CW 使用当前浏览器的 IndexedDB 保存已读取消息、历史页、内容块及主机 / 会话目录，按站点、凭证身份、主机和会话隔离。Agent 离线时，在仍可访问网页和完成中继认证的条件下，可选择已缓存会话查看已有内容；未缓存页面等待 Agent 恢复。浏览器配额、隐私模式或清理站点数据可能使缓存不可用，页面会提示并继续支持在线读取。“清理本机会话缓存”只清理该会话的浏览器副本。移除凭证和远程撤销不能擦除设备上已经保存的数据；需要时清理站点数据。缓存不作为唯一历史副本。

CC 保留原生 Codex TUI，通过额外的只读双向连接自动缓存连接期间的最新历史。以下命令读取历史并写入本机 SQLite，也适用于已结束的 CLI 会话：

```bash
coc-client history SESSION_ID --host A_ID
coc-client history SESSION_ID --host A_ID --before CURSOR
coc-client history SESSION_ID --host A_ID --seq CONTENT_SEQ --offset 0
coc-client history SESSION_ID --host A_ID --offline true
coc-client cache-clear SESSION_ID --host A_ID
```

`history` 输出 JSON，使用返回的 `cursor` 向前分页（归档游标可能为负数），使用 `contentSeq` 和 `nextOffset` 读取大内容；离线读取需要相同参数的页面此前已缓存。`cache-clear` 清理当前凭证和主机下的全部 CC 历史缓存，不影响 Agent。默认缓存位于 `~/.config/coc-client/history/<身份摘要>/agent.db`；可用 `COC_HISTORY_DIR` 或 `--cache-dir PATH` 指定根目录。SQLite 文件权限为 `0600`、身份目录为 `0700`，凭证原文不写入缓存。退出登录不自动删除缓存，新凭证不会复用旧凭证的缓存。

历史缓存不改变原生 TUI 的历史界面或 CLI 跨会话恢复策略。超过网络单帧的原生 RPC 结果通过 `history` 分块读取，不会因该结果断开整台 Agent。模型上下文窗口与磁盘空间仍受各自限制。

## 9. 从 0.2.x 升级

这是不兼容的认证升级，需同时更新 R、网页及原生程序。

1. 安装 `coc-agent` / `coc-client`，移除旧 `coc`；将 systemd 启动命令改成 `coc-agent run --config ...`。
2. 旧的 8 小时客户端凭证、旧 Agent 令牌和旧管理员 Cookie 不再接受；所有者密钥保持不变。
3. 停止旧 Agent，备份配置和数据目录；用 `coc-agent logout --config ...` 清除旧配置中的令牌，然后用 `login --config ...` 重新申请。项目与 dataDir 保留，A 标识改变。
4. CC 使用新的多授权凭证文件；旧 `~/.config/coc/credentials.json` 不自动导入。CW 对每个新 A 单独申请。
5. 原 `enroll`、`agent-enroll`、客户端 `revoke`、验证码兑换接口退出支持，统一使用网页审批和撤销。

SQLite 会话 / 事件格式不变；每个 dataDir 只运行一个 Agent。旧活动会话在重启时标记失败；CW 可从 Codex 历史恢复线程，但不恢复原进程或自动重发未完成任务。

## 10. 排错

登录申请过期或被拒绝时重新申请；核对目标 A 是否存在、已授权且未撤销。短期频繁申请会限流。看不到项目时检查 A 配置、目录权限；主机离线时检查进程、WSS、凭证和 Codex 版本。GLIBC 问题参见容器方案，不要替换系统 libc。

报告问题提供时间、主机 / 会话 ID、版本和错误码，不提供令牌、所有者密钥或模型凭据。已测范围及未完成验收见 [测试记录](TEST_REPORT.md)。

## 0.5.1 稳定化更新

Worker、网页和 Agent/CC 请配套更新到 0.5.1；旧 Agent 未完成能力协商时会返回 `AGENT_NEGOTIATING`，安装新包并重启 Agent 后再连接。升级前备份数据，合并重复或父子项目根目录。

聊天顶部持续显示服务器、项目与连接状态。历史和新建可直接访问；详情包含完整路径、会话标识与本机存储。相邻工具调用合并为默认折叠的一组，错误摘要保留文字提示；展开组后可逐项阅读、复制命令或输出。大回复继续按 Markdown 展示，“展开更多”累积读取；显示窗口保留最多约 128 Ki 字符，完整权威内容仍可通过历史接口分块读取。

审批一次显示当前请求与待确认数量，命令/原因/目标在正文中，拒绝与允许本次固定在下方。可前后切换审批；没有批量允许。文件请求按 itemId 关联已收到的变更事件，显示路径、类型及可展开 diff；缺少明细时明确提示。未知参数保留在请求详情。多个审批不会把输入和停止按钮推到视口之外。关闭文件面板时会明确确认取消传输；点击内部空白不关闭，Escape 与关闭按钮遵循相同语义。

允许选择已授权的离线服务器，读取此浏览器已保存的目录和历史；未缓存的内容需要等服务器恢复。网页与中继认证仍须可用，这不是完全离线 PWA。断线时远程任务可能仍在运行。临时票据错误会退避重试，控制冲突/撤销进入只读或需重新登录；“重新连接”和“接管控制权”分开，接管须确认目标。

任务草稿按中继、凭证身份、主机和会话保存在本机 IndexedDB；切换/刷新后恢复。发送前保存稳定请求身份，响应丢失时显示“待确认”并提供查询，禁止自动以新请求再提交。创建会话也保存独立请求 ID，刷新后可继续确认。清理会话缓存只删除历史副本，保留草稿与待确认身份；浏览器清除站点数据会移除这些本地信息。若浏览器无法保存待确认身份，会保留草稿并阻止提交，修复站点存储后再试；已缓存和在线历史仍可读取。桌面 Enter 发送、Shift+Enter 换行，触控设备 Enter 换行，用按钮发送；中文输入法组合态不会误发送。

消息区向上滚动接近顶部会自动异步加载更早消息，手动加载按钮仍可使用；历史向上加载会完整合并较早消息，保留阅读锚点及此前已加载消息；使用“返回最新内容”恢复有界实时窗口。列表搜索只搜索已加载记录；目录分页和 Codex 线程分页分别有“加载更多”入口。查看只读历史与恢复并继续有明确文案。缓存达到配额或无法打开时提示，权威历史保存在服务器。

文件面板显示服务器和项目、项目根目录面包屑、文件名/数量/进度。下载成功提示表示已交给浏览器，不能保证用户最终保存。上传提交响应丢失时保留 uploadId，重新打开面板可查询；完成结果与 SHA-256 在 Agent 保留 24 小时，跨 Agent 重启可查。24 小时后或发布与日志之间发生断电时，仍须人工核对目标文件。覆盖会检查版本，但本机其他写入者不参与原子比较交换；运行任务和上传可能并发改同一项目，请先停止相关写入再覆盖。

管理员“退出管理”会撤销当前服务端登录；可退出其他管理会话。轮换所有者密钥也使旧管理登录失效。A/CC 的本地 logout 仍只忘记本地凭证，不撤销设备授权。设备撤销与会话审批是不同操作。

### 原生命令与查询

```bash
coc-agent --version
coc-client --version
coc-agent doctor --config /path/agent.json
coc-client doctor --host HOST_ID
coc-client sessions --host HOST_ID --cursor LAST_ID
coc-client connect --host HOST_ID --project PROJECT_ID --request-id STABLE_ID
coc-client request STABLE_ID --host HOST_ID
coc-client request STABLE_ID --host HOST_ID --session SESSION_ID
coc-client history SESSION_ID --seq SEQ --offset 0
coc-client history SESSION_ID --seq SEQ --offset 4096 --revision REVISION
```

`--version` 为 JSON，含版本、提交、源码摘要、协议和能力；doctor 检查配置、Codex 0.164.0、TLS、项目权限、磁盘与 SQLite，不调用模型。HTTP DNS 解析使用系统 `/usr/bin/getent`，请保留发行版 libc-bin。CLI 在启动 TUI 前检查本机 Codex 版本。

目录响应是 `{data,nextCursor}`，每页最多 100 条。大内容首块自动保存 revision；后续内容缓存也绑定 revision，正文变化返回 `CONTENT_CHANGED`，从 offset 0 重新读取。CLI 历史观察连接会独立重连，缓存故障不终止 TUI。CLI 仍不支持接管已附着的 CLI runtime；请先结束旧会话再新建。

HTTP 每次请求的截止时间为 30 秒。`HTTP_TIMEOUT`、`RESULT_UNKNOWN` 或任务提交后断线均不能证明任务未执行。保留原请求 ID，先查询/核对历史；不要重新生成 ID 提交同一任务。

凭证通过同目录 0600 临时文件、fsync、原子发布与父目录 fsync 保存；并发登录/切换由锁拒绝，提示 `CONFIG_BUSY`。项目根目录不能重复、互为父子或通过符号链接规范化到相同目录；升级前合并这类别名配置。

### 权威数据库备份与恢复

```bash
python3 scripts/state-backup.py backup --data-dir /path/data --file /safe/snapshot.db
# 恢复前停止 Agent，并先另做当前状态备份：
python3 scripts/state-backup.py restore --data-dir /path/data --file /safe/snapshot.db
```

备份使用 SQLite 在线备份 API，包含 WAL 中已提交数据，输出权限为 0600，拒绝覆盖既有备份。恢复使用与 Agent 相同的实例锁；Agent 运行时拒绝恢复。恢复历史不会恢复 Codex 进程或回滚项目文件。秘密配置、Codex home 和工作区需要独立备份；不要只复制活动数据库的 `.db` 文件。

0.5.2 同时修复会话刚停止时读取尚未缓存的旧历史页：使用独立只读 Codex 进程，不向正在退出的运行进程发送历史请求。
