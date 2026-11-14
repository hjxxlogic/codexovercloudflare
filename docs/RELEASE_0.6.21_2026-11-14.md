# 0.6.21 本机 Agent 更新

本次修复 Codex 子 Agent 通知覆盖主会话轮次的问题（修复提交 `b809928`）。主会话按 threadId 隔离通知，停止本轮使用主线程对应的 turnId。

用户明确要求跳过 GitHub Actions，使用 `scripts/deploy-agent.py --local --local-build` 构建并部署到本机 systemd 用户服务 `coc-agent.service`，目标 `/home/ubuntu/.local/bin/coc-agent`。本地产物不标记为 CI 验证制品；不发布 Worker、网页、下载包或 GitHub Release。

修复已通过队列集成测试、原生 CTest 16/16、C++ 格式及新增测试 ESLint。版本更新保持协议 1。部署脚本核对源码身份和 SHA256，等待空闲、备份二进制并执行服务核验，保留配置、凭据和数据库。原始证据保存在忽略目录 `.local/deploy-agent-0.6.21/`。

## 部署结果

- 部署源码：`2a24ad98e46cbeebc56763bea54021603557053a`，版本 `0.6.21`，干净提交。
- 源码摘要：`dea78f1d8982142ef461ea989fd6090b59fc838ab4052804af8ee3d7af78e5e9`。
- Agent SHA256：`5efc82d6c4db10eca595527bd5a79d2308b19dbabdeace35e5bc16f8b15b9c5f`。
- 命令：`python3 scripts/deploy-agent.py --local --local-build --binary /home/ubuntu/.local/bin/coc-agent --output .local/deploy-agent-0.6.21 --apply`。
- 部署前确认空闲；已备份原二进制，安装后完成 120 秒观察：服务持续运行、PID 稳定、中继握手成功，无 Pong timeout 或重连预算耗尽。
- 本机运行版本回读为 `0.6.21`，commit / sourceDigest 与上述来源一致。未升级本机 CLI。
- GitHub Actions 按用户要求跳过，无 Actions URL；未验证跨平台发行制品，未以真实模型重新执行子 Agent 中断场景，专项行为由部署前的确定性集成回归覆盖。
