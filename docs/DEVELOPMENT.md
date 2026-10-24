# 开发与本机测试

## 1. 目录与工具

- `native/include/coc/`、`native/src/`：C++17 公共接口、Agent、CLI、网络、进程和 SQLite。
- `native/tests/core.cpp`：CTest 与真实 Codex smoke。
- `apps/relay/src/`、`apps/web/src/`：TypeScript 中转与 React 页面。
- `packages/protocol/`：云端 / 网页的类型与 Zod 校验；C++ 按相同协议单独校验。
- `tests/`：Vitest 协议边界、真实 Wrangler/Chromium 集成；`tests/support/` 仅为原生进程和断网注入工具。
- `scripts/`、`examples/`、`docs/`：初始化、TUI smoke、配置、systemd 和文档。

Linux 编译依赖：C++17、CMake ≥ 3.16、Boost.System ≥ 1.71、OpenSSL、SQLite3、nlohmann/json ≥ 3.7。Ubuntu / Debian：

```bash
sudo apt-get install build-essential cmake libboost-system-dev libssl-dev libsqlite3-dev nlohmann-json3-dev clang-format
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 2
cmake -E chdir build ctest --output-on-failure
```

本机二进制不依赖 Node.js，运行时需要与编译目标兼容的动态库。可执行 `sudo cmake --install build --prefix /usr/local` 安装。当前验证 Linux x86_64；不承诺跨发行版直接复制二进制。

云端、网页和 TypeScript 测试工具需要 Node.js ≥ 22.17（建议 24），执行 `npm ci`。Codex 固定 `0.164.0`，Agent 启动时检查版本。

## 2. 常用命令

| 命令                                              | 用途                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `npm run build:native`                            | CMake Release 构建 Agent、CLI 与原生测试。                 |
| `./build/coc-agent run --config /path/agent.json` | 启动 C++ Agent。                                           |
| `./build/coc-client hosts`                        | 使用 C++ CLI，默认中转 `https://r.xlogic.cc`。             |
| `npm run agent -- ...` / `npm run client -- ...`  | 调用上述二进制的开发快捷入口，需先构建。                   |
| `npm run setup:local`                             | 生成被忽略的开发秘密，拒绝覆盖已有配置。                   |
| `npm run dev`                                     | 构建网页并启动 `127.0.0.1:8787` Wrangler。                 |
| `npm run build`                                   | 原生构建、网页构建、类型检查和 Worker dry-run；不部署。    |
| `npm run typecheck`                               | 检查保留的 TypeScript 与测试工具。                         |
| `npm run lint` / `npm run format`                 | ESLint / Prettier 检查与修正。                             |
| `npm run lint:cpp` / `npm run format:cpp`         | 使用 clang-format 检查 / 修正 C++。                        |
| `npm test`                                        | CTest 加 Vitest；不调用模型。                              |
| `npm run test:e2e`                                | C++ Agent / CLI + Wrangler + 模拟 Codex + Chromium。       |
| `npm run test:tls`                                | 本地 CA 验证 C++ HTTPS / WSS 的信任链、主机名与认证头。    |
| `npm run test:codex`                              | C++ 进程层连接真实 Codex，初始化只读线程，不提交模型任务。 |
| `npm run test:native`                             | 原生 Codex TUI 经完整本机中继初始化，不提交模型任务。      |

`test:e2e` 前构建 C++、网页并安装 Playwright Chromium。`test:native` 需要 Python 3、Docker、`coc-local-test` 镜像及宿主 `codex`；中转运行在 Linux host network 容器，C++ Agent / Codex 在宿主运行。旧 `--relay` 参数仍可传入，但不再切换到测试专用 bridge。

真实模型测试会使用已配置的模型服务：

```bash
npm run test:task
npm run test:native -- --task
```

第一项使用 C++ 进程层在临时项目创建并校验 `proof.txt`；第二项验证原生 TUI 经 Worker、Durable Object 和 C++ Agent 的模型对话。测试使用临时端口和凭据，不连接生产。

## 3. Ubuntu 20.04 容器方案

新版 workerd 需要更新的 glibc；用 Bookworm 容器运行中转和浏览器，不替换宿主系统库：

```bash
docker build -f Dockerfile.test -t coc-local-test .
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'npm ci && cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2 && npm run build:web && npx playwright install chromium && COC_AGENT_BINARY=.local/build-container/coc-agent COC_CLI_BINARY=.local/build-container/coc-client npm run test:e2e'
```

容器和宿主分别使用构建目录，防止混用 OpenSSL / glibc 动态库。容器默认 root，构建文件写入挂载目录；不要挂入生产凭据。宿主已有匹配浏览器缓存时，可挂载缓存并设置 `PLAYWRIGHT_BROWSERS_PATH`；`COC_BROWSER_PATH` 可指定其他兼容浏览器路径。

开发中继：

```bash
docker run --rm --init --network host -v "$PWD:/workspace" coc-local-test npm run dev
```

Wrangler 只监听回环地址。其他操作系统需自行适配端口映射和监听地址，不应向公网暴露开发 HTTP。

## 4. 风格、配置与迁移

0.3.0 仅构建和安装 `coc-agent` / `coc-client`。`native/src/login.cpp` / `native/include/coc/login.hpp` 共用参数解析、配置路径、设备授权轮询和凭证状态检查；各程序保留自身角色命令。`login`、`logout`、`status` 和 `--relay` / `--name` / `--config` 语义一致。Agent 使用 `COC_AGENT_CONFIG`，客户端使用 `COC_CREDENTIALS`；客户端配置版本为 2，包含按 R / A 索引的 entries 和 selected。

设备认证协议升级到 version 2，旧宽权限 client / agent / owner Cookie 不再接受。重新使用所有者密钥登录管理网页，A 自行申请授权，CC / CW 按 A 授权。旧项目和 SQLite 格式保留，systemd 改用 `run --config`。具体迁移顺序见用户手册，不能继续使用原登记或验证码流程。

C++ 使用 2 空格、snake_case 函数、PascalCase 类及 `.clang-format`，测试失败不得依赖 Release 会禁用的 `assert`。TypeScript 保持 strict、ESLint、Prettier，测试命名 `*.test.ts`。添加功能时同时更新 C++ / Zod 协议与跨语言测试。

- `.dev.vars`、`.local/owner-secret`：开发秘密；所有者密钥至少 32 字符。
- `.local/agent.json`：设备令牌与项目配置；Agent 登录写入权限 `0600`。
- `.wrangler/`：DO 开发状态；删除会丢失设备登记与登录会话。
- Agent `dataDir/agent.db`：SQLite 会话、去重和事件；WAL，默认保留 7 天、约 1 GiB 上限。
- `~/.config/coc-client/credentials.json`：CLI 凭据；可用 `COC_CREDENTIALS` 指定路径。

停止旧 TypeScript Agent 后，直接用 C++ Agent 读取原配置和 dataDir。表结构不变；启动后旧活动会话标记失败，不恢复旧进程。每个 dataDir 只运行一个 Agent；C++ 使用文件锁拒绝第二个实例。不要直接复制活跃 WAL 数据库的单个 `.db` 文件；停机备份或使用 SQLite 备份机制。

`codexArgs` 只允许管理员配置受信任的包装器；不能接受客户端输入。CLI / Agent 均使用参数数组启动程序，不使用 shell 拼接。systemd 示例直接执行 `/usr/local/bin/coc-agent`。

## 5. 部署准备

`wrangler.jsonc` 已配置 `r.xlogic.cc` 自定义域名及账号，关闭 workers.dev 和预览 URL。生产发布必须携带网页和原生下载包，并使用独立生产密钥；具体步骤见 [发布操作](RELEASE.md)。发布后的 HTTP 冒烟测试不替代跨网络会话、DO 休眠唤醒和长期负载验证。Agent 使用非 root 用户，配置 Codex home、项目权限与持久 dataDir，参见 [systemd 示例](../examples/coc-agent.service)。

TLS 在 Cloudflare 终止；当前不提供端到端加密或不可信多用户隔离。完整目标与验证边界见 README 和测试记录。

## 0.3.1 API Key

共用 login 接口支持 `login --api-key`，从 `COC_API_KEY` 或隐藏终端 / 标准输入读取，成功后将原 Key 存入现有 token 字段，沿用私有配置与业务接口。终端参数不接受 Key 值。Key 创建 / 绑定 / 撤销由 RegistryDO 负责，CC 目标在创建时校验，A 首次绑定使用事务，重复使用不创建第二个 A。创建响应之外不返回秘密，不增加兑换令牌。

`tests/device-auth.test.ts` 覆盖角色必填、目标固定、直接 Bearer、多年有效、并发绑定和级联撤销；`tests/e2e.ts` 通过管理网页生成两类 Key，实际运行两个原生程序并验证保存的 token 就是 Key、重复登录绑定一致和活动连接撤销。测试截图在忽略目录 `.local/api-key-management.png`。

发布后必须验证 Registry 新接口实际可用，再完成登录验收。Worker 与 Durable Object 代码在全球最终一致传播，可能出现新网页已上线而 Registry 暂时仍返回旧版本的 `NOT_FOUND: Unknown operation`；不能仅依据 `wrangler deploy` 成功就宣告功能验收通过。参见 [Cloudflare 代码更新说明](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#code-updates)。等待传播后重试验证，不要清空生产 DO 状态或更改设备身份。

## CW 网页开发

网页使用 react-markdown / remark-gfm 渲染聊天 Markdown。`main.tsx` 管理功能分页、自动收起菜单与会话生命周期；`events.ts` 负责有序去重和流式组装。新增本地历史接口须同时更新 Worker 路由校验与原生 Agent 校验，不向网页开放任意 app-server RPC。

`tests/e2e.ts` 的确定性协议夹具包含本地历史及异项目线程，验证历史列表过滤、恢复历史与继续对话、分页 / 搜索、Markdown / 安全链接、折叠工具、移动端宽度和功能菜单。截图输出 `.local/cw-chat-desktop.png`、`.local/cw-chat-mobile.png`；测试不调用模型。历史功能需要与 Worker 一起更新原生 Agent。
