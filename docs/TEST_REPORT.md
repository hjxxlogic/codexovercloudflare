# 本机测试记录

日期：2026-10-24。版本：C++ 迁移开发版 0.2.0。记录已测本机场景及生产发布冒烟，不代表全部需求验收。

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

## 尚未完成的验收

- 生产 DO 休眠唤醒、跨网络会话和发布断线；HTTP 发布冒烟不覆盖这些场景。
- 4 会话持续 8 小时、P95 延迟、1 GiB 配额与慢客户端长期压力。
- CLI 再附着、Agent 重启后的旧线程恢复、超大事件分片。
- 全部审批类型、全部原生 TUI 功能、macOS / Windows 和移动浏览器兼容性。
- 组织账户、强租户隔离、端到端加密；这些不在首版本机实现范围。

复现命令见 [开发说明](DEVELOPMENT.md)。不要将本记录视为 A-01 至 A-09 全部验收完成。
