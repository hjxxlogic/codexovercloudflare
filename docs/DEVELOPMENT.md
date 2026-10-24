# 开发与本机测试

## 1. 目录与工具

```text
apps/relay/src/     Worker、设备登记、鉴权与 Durable Objects 中转
apps/agent/src/     Codex 子进程、项目策略、SQLite 日志与出站连接
apps/cli/src/       coc 登录、设备登记和原生 TUI 启动器
apps/web/src/       React 网页
packages/protocol/ 共用类型、Zod 校验及大小限制
scripts/           本地初始化与真实 Codex smoke
examples/          配置和 systemd 示例
tests/             单元、跨组件和浏览器测试
```

当前使用一个根 `package.json` 管理全部源码和依赖；尚未拆分可独立发布的 workspace 包。TypeScript strict、2 空格缩进、ESLint、Prettier。单元测试以 `*.test.ts` 命名，跨组件测试入口为 `tests/e2e.ts`。

## 2. 常用命令

| 命令                                | 用途                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `npm ci`                            | 根据 lockfile 安装依赖。                                            |
| `npm run setup:local`               | 生成被忽略的本地所有者密钥；已有配置时拒绝覆盖。                    |
| `npm run dev`                       | 构建网页，启动绑定 `127.0.0.1:8787` 的 Wrangler。                   |
| `npm run agent -- /path/agent.json` | 运行 Agent；启动时验证 Codex 版本。                                 |
| `npm run coc -- ...`                | 运行 CLI，默认中转为 `https://r.xlogic.cc`。                        |
| `npm run build`                     | 构建网页、类型检查和 Worker dry-run，不部署。                       |
| `npm run typecheck`                 | 检查全部 TypeScript。                                               |
| `npm run lint` / `npm run format`   | 检查 / 修正源码格式和 lint。                                        |
| `npm test`                          | Vitest 单元测试，无模型调用。                                       |
| `npm run test:e2e`                  | 自动启动隔离 Wrangler、模拟 Codex 和 Chromium，测试后清理。         |
| `npm run test:codex`                | 真实 Codex 初始化和只读临时线程创建，无模型调用。                   |
| `npm run test:native`               | PTY 启动真实原生 TUI，通过受限 WS/stdio bridge 初始化，无模型调用。 |

真实模型测试（会使用服务器配置的模型服务）：

```bash
npm run test:task
npm run test:native -- --task
# 先构建 coc-local-test 镜像，再验证完整本机中继链路：
npm run test:native -- --relay --task
```

`--relay` 使用 Linux Docker host network，由容器运行 workerd，Agent 和 Codex 运行在宿主；端口和凭据均为临时值，测试结束后停止容器。

`test:native` 需要 Python 3 和可用的 `codex`。`test:e2e` 前先执行 `npm run build:web` 和 `npx playwright install chromium`。测试使用随机本地秘密和临时目录，不使用生产域名或设备。

## 3. Ubuntu 20.04 容器方案

新版本 workerd 不能在本机 glibc 2.31 上直接运行。仓库提供基于 Debian Bookworm 的测试镜像，不替换宿主系统库：

```bash
docker build -f Dockerfile.test -t coc-local-test .
docker run --rm --init -v "$PWD:/workspace" coc-local-test \
  sh -c 'npm ci && npm run build:web && npx playwright install chromium && npm run test:e2e'
```

依赖和构建文件写入挂载的仓库，容器默认用户为 root；可根据环境调整用户和浏览器缓存权限。不要把生产凭据挂入测试容器。

如宿主机已有匹配版本的 Playwright 浏览器缓存，可只读挂载并设置 `PLAYWRIGHT_BROWSERS_PATH`，避免重复下载。`COC_BROWSER_PATH` 可指定其他兼容 Chromium 的绝对路径。

在 Linux 容器中运行开发中继可使用：

```bash
docker run --rm --init --network host -v "$PWD:/workspace" coc-local-test npm run dev
```

该命令使用 Linux host network，Wrangler 仍只监听回环地址；宿主上的 Agent、CLI 和浏览器使用 `http://127.0.0.1:8787`。其他操作系统需自行配置端口映射和监听地址，不应直接把本地 HTTP 暴露到公网。

## 4. 配置与状态

- `.dev.vars`：Wrangler 开发秘密，`OWNER_SECRET` 至少 32 字符；勿提交。
- `.local/owner-secret`：本地登录密钥副本，权限 `0600`。
- `.local/agent.json`：设备凭据、项目及 Agent 设置；由 `agent-enroll` 创建，权限 `0600`。
- `.wrangler/`：开发 DO 状态，删除会丢失设备登记和登录会话。
- Agent `dataDir`：SQLite 会话、请求去重和网页事件；删除可能失去去重依据。
- `~/.config/coc/credentials.json`：CLI 登录凭据；通过 `COC_CREDENTIALS` 可指定其他文件。

配置使用 JSON，示例见 [agent.example.json](../examples/agent.example.json)。`codexArgs` 仅供受信任的服务器管理员配置可执行文件包装器；不接受客户端输入。

每个 dataDir 仅运行一个 Agent 实例；默认事件保留 7 天，上限约 1 GiB。结束会话后历史仍保留。不要在活跃数据库上直接复制单个 `.db` 文件，备份应停机或使用 SQLite 备份机制。

## 5. 部署准备

当前任务仅进行本机测试，没有部署到 `r.xlogic.cc`。准备部署时：

1. 在 `wrangler.jsonc` 配置自己的 Cloudflare 账号与自定义域名 route：`{"pattern":"r.xlogic.cc","custom_domain":true}`。
2. 用 `npx wrangler secret put OWNER_SECRET` 配置独立生产密钥，不复用本地测试密钥。
3. 完成生产网络、DO 休眠/唤醒、部署断线和负载验证后再发布。
4. Agent 使用非 root 系统用户，并配置 Codex home、项目权限与持久 dataDir；systemd 模板见 [coc-agent.service](../examples/coc-agent.service)。

云端默认不存正文，但 TLS 在 Cloudflare 终止，中转可以看到内容。当前是开发版本，完整目标与未实现事项见 README 和测试记录。
