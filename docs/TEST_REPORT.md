# 本机测试记录

日期：2026-10-24。当前结果适用于开发版本，不代表全部需求验收完成。

## 环境

- 宿主：Ubuntu 20.04、glibc 2.31、Node.js 22.17.0、Codex 0.164.0。
- 中继/浏览器集成：本机 Docker，Debian Bookworm、Node.js 22、真实 Wrangler/workerd、Playwright Chromium。
- 测试使用临时项目、随机测试凭据和隔离 DO 状态，没有部署或连接生产 `r.xlogic.cc`。

## 已通过

| 检查            | 证据与边界                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript      | `npm run typecheck` 通过。                                                                                                                                                                       |
| 单元测试        | `npm test`：协议边界、权限拦截、凭据脱敏、SQLite 幂等与恢复、双向审批协议。                                                                                                                      |
| 构建            | `npm run build`：网页构建、类型检查、Worker dry-run 成功，没有发布。                                                                                                                             |
| 中继端到端      | `npm run test:e2e`：真实 Wrangler + Agent + 确定性模拟 Codex，覆盖认证、一次性登记、项目限制、流式输出、重复 prompt 去重、审批拒绝、控制权接管、票据重复使用拒绝、历史回放、CLI RPC 及权限拒绝。 |
| 网页            | 同一端到端测试使用真实 Chromium，完成 Cookie 登录、主机/项目选择、创建会话、任务提交和流式答复。                                                                                                 |
| 故障恢复        | 模拟 Agent 网络中断，保留 runtime 并恢复网页历史；撤销设备时关闭客户端连接。                                                                                                                     |
| 真实 Codex 协议 | `npm run test:codex`：真实 app-server 初始化和只读临时线程创建，无模型调用。                                                                                                                     |
| 真实模型任务    | `npm run test:task`：真实模型在临时 workspace 中创建 `proof.txt`，内容精确校验后清理。此测试会使用配置的模型服务。                                                                               |
| 原生终端初始化  | `npm run test:native`：真实 Codex TUI 经 PTY 和受限 WS/stdio bridge 初始化并创建线程；通用 `command/exec` 启动探测被明确拒绝。                                                                   |

另外已通过 `npm run test:native -- --relay --task`：真实原生 TUI → 本机 Worker → Durable Object → 宿主 Agent → 真实 Codex，完成一轮只读模型对话。中继运行在本机容器内，生产 Cloudflare 网络未参与。

`test:e2e` 的模拟 Codex 不运行 shell，也不调用模型。真实模型任务和完整原生链路是独立测试；当前只证明已测场景，尚未覆盖所有终端功能和历史分页行为。原生 CLI 的通用 `command/exec`、已有线程后新建线程等请求会被明确拒绝。

## 环境问题与解决方式

宿主无法直接运行新版 workerd，报缺少 GLIBC 2.32–2.35；新版 Playwright 也不再为 Ubuntu 20.04 提供默认浏览器包。因此在本机 `Dockerfile.test` 容器中验证真实中继和浏览器，宿主库没有修改。真实 Codex smoke 在宿主运行。

Wrangler 的间接依赖 undici 通过 override 升至已修复版本；当前 lockfile 的 `npm audit` 无已知漏洞。升级依赖后需重新运行检查。

## 尚未完成的验收

- Cloudflare 真实部署的休眠唤醒、跨网络连接、发布断线及区域延迟。
- 4 会话持续 8 小时、P95 延迟目标和 1 GiB 日志配额的长时间负载测试。
- CLI 再次附着与线程恢复；Agent 重启后的显式线程恢复。
- 超大事件分片、完整慢客户端压力及所有审批类型。
- Windows/macOS CLI 和移动端浏览器兼容性。
- 组织账户、强租户隔离、端到端加密；这些也不在首版实现范围。

复现方法见 [开发说明](DEVELOPMENT.md)。完整需求中的 A-01 至 A-09 仍需按未覆盖部分继续验收，不能将本记录作为全部发布准入通过证明。
