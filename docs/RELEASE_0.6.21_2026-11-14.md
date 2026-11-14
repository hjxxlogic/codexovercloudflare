# 0.6.21 本机 Agent 更新

本次修复 Codex 子 Agent 通知覆盖主会话轮次的问题（修复提交 `b809928`）。主会话按 threadId 隔离通知，停止本轮使用主线程对应的 turnId。

用户明确要求跳过 GitHub Actions，使用 `scripts/deploy-agent.py --local --local-build` 构建并部署到本机 systemd 用户服务 `coc-agent.service`，目标 `/home/ubuntu/.local/bin/coc-agent`。本地产物不标记为 CI 验证制品；不发布 Worker、网页、下载包或 GitHub Release。

修复已通过队列集成测试、原生 CTest 16/16、C++ 格式及新增测试 ESLint。版本更新保持协议 1。部署脚本核对源码身份和 SHA256，等待空闲、备份二进制并执行服务核验，保留配置、凭据和数据库。部署结果与摘要在执行后补充；原始证据保存在忽略目录 `.local/deploy-agent-0.6.21/`。
