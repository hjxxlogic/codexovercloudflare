# 更新日志

记录面向使用者的功能、修复和兼容性变化。`0.2.0` 为开发预览版本，不表示全部需求验收通过。

## 网站修复 · 2026-10-24

- 为下载区 Markdown 明确设置 UTF-8 纯文本响应头，修复浏览器直接打开中文用户手册时的乱码。

## 0.2.0 · 2026-10-24

### 架构变更

- 本机 Agent 与 CLI 从 TypeScript 改为 C++17，使用 CMake、Boost.Asio/Beast、OpenSSL、SQLite3 和 nlohmann/json；中转与网页保留 TypeScript。
- 新增 `coc-agent` / `coc` 二进制、CTest 和 clang-format 约定；运行本机程序不依赖 Node.js。
- 保留现有配置、设备认证、会话协议、SQLite 表结构与数据目录；停止旧 Agent 后再启动 C++ 版本。
- 增加 dataDir 文件锁和 HTTPS/WSS 本地 CA 测试，严格拒绝未知 CA 与主机名不匹配的证书。
- systemd 直接启动原生 Agent；更新用户手册、开发指南和架构说明。原生 TUI smoke 统一经过完整本机中继。

### 发布

- 增加 `r.xlogic.cc` 自定义域名配置、Linux x86_64 二进制 / 源码发布包、SHA256 校验和及发布操作文档。

### 新增

- Cloudflare Worker 中转及 RegistryDO、HostRelayDO，按主机协调出站 WebSocket 连接。
- 单所有者登录、一次性设备登记、独立设备令牌、短期会话票据与设备撤销。
- Linux Agent：项目白名单、Codex 子进程管理、服务器权限策略和受限 RPC 转发。
- CLI：登录、主机与项目查询、设备登记、创建原生 Codex TUI 会话及停止会话；默认中转为 `https://r.xlogic.cc`。
- React 网页：登录、选择项目、文本任务、流式输出、代码差异、命令/文件审批、停止及控制权接管。
- SQLite 会话与事件日志、请求幂等处理、网页事件回放和 Agent 网络重连。
- 本地初始化脚本、JSON 配置示例、systemd 模板及 Docker 测试环境。
- 用户手册、开发说明、需求与架构文档及本机测试记录。

### 验证

- 已通过 CMake 原生构建、CTest、Vitest、HTTPS/WSS 证书回归、类型检查、ESLint、Prettier、clang-format 及网页/Worker 构建。
- 已通过真实 Wrangler 与 Chromium 的本机端到端测试，包括认证、审批拒绝、重复提交去重、接管、回放、重连和撤销；使用模拟 Codex。
- 已通过真实 Codex 临时项目文件任务，以及原生 TUI 经完整本机中继的一轮模型对话。
- 详细环境和证据见 [本机测试记录](docs/TEST_REPORT.md)；以上不代表生产部署或全部需求验收完成。

### 当前限制

- Codex 兼容版本固定为 `0.164.0`；仅中转、网页开发和 TypeScript 测试工具需要 Node.js ≥ `22.17.0`。
- CLI 暂不支持再次附着已有 runtime；Agent 重启后尚无旧线程恢复入口。
- 单帧上限 256 KiB，尚无超大消息分片；网页补充问答和 MCP elicitation 暂不支持。
- 首版面向个人可信操作者，不提供文件同步、强租户隔离或端到端加密。
- 生产入口为 `r.xlogic.cc`，提供网页、原生程序和源码下载；休眠唤醒、跨网络会话与长期负载测试仍待完成。

## 初始开发记录 · 2026-10-24

- `93945e3`：实现中转、Agent、CLI、网页、测试及使用文档。
- `ce89615`：建立项目需求与技术架构基线。
- `512fb46`：添加初始仓库指南与设计构想。
