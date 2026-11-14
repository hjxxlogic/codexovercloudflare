# 0.6.22 本机 Agent 更新

CW 在主轮次运行时，将已确认排队的消息按顺序通过 turn/steer 追加到当前轮次，由 Codex 在下一个可处理节点处理；空闲时仍通过 turn/start 启动新轮次。保留原 activeTask / turnId、队列去重、容量限制、取消与未知结果保护。轮内追加沿用当前轮次模型，入队模型仅在启动新轮次时使用。

用户明确要求升级版本、提交并跳过 GitHub Actions 部署。本次使用仓库 `scripts/deploy-agent.py --local --local-build` 更新本机 `coc-agent.service`，目标 `/home/ubuntu/.local/bin/coc-agent`，本地产物不标记为 CI 验证制品。部署前等待空闲，备份二进制并执行 120 秒服务与中继连接核验。保留凭据、配置和数据库。不发布 Worker、网页、下载包或 GitHub Release。

版本升级前的功能修改已通过队列集成回归、原生 CTest 16/16、TypeScript、C++ 格式、测试 ESLint / Prettier；协议保持 1。未调用真实模型验证工具边界处理时机，专项行为通过真实 Agent 与确定性 Codex peer 验证。原始证据保存在忽略目录 `.local/deploy-agent-0.6.22/`。

## 部署结果

- 部署源码：`17ccac0f1124d4df607baaa697adb0de0ab4a0cc`，版本 `0.6.22`，源码干净。
- 源码摘要：`2e8f25e2db51bc5a82076c397ce7aaccf7665e0127358143df6827e08677e0a5`。
- Agent SHA256：`36c0ba3f30e1ce0644eaa0957254a328efb192b786e422c40e17901c4aa2732e`。
- 命令：`python3 scripts/deploy-agent.py --local --local-build --binary /home/ubuntu/.local/bin/coc-agent --output .local/deploy-agent-0.6.22 --apply`。
- 部署前空闲，原二进制已备份；安装后 120 秒核验通过，PID 稳定、中继握手成功，无 Pong timeout 或重连预算耗尽；运行版本回读为 0.6.22，commit / sourceDigest 一致。
- Actions 按用户要求跳过，无 Actions URL。仅更新本机 Agent，未更新 CLI 或云端服务；跨平台发行和真实模型的工具边界处理时机未在本次部署中验证。
