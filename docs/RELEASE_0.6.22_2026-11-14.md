# 0.6.22 本机 Agent 更新

CW 在主轮次运行时，将已确认排队的消息按顺序通过 turn/steer 追加到当前轮次，由 Codex 在下一个可处理节点处理；空闲时仍通过 turn/start 启动新轮次。保留原 activeTask / turnId、队列去重、容量限制、取消与未知结果保护。轮内追加沿用当前轮次模型，入队模型仅在启动新轮次时使用。

用户明确要求升级版本、提交并跳过 GitHub Actions 部署。本次使用仓库 `scripts/deploy-agent.py --local --local-build` 更新本机 `coc-agent.service`，目标 `/home/ubuntu/.local/bin/coc-agent`，本地产物不标记为 CI 验证制品。部署前等待空闲，备份二进制并执行 120 秒服务与中继连接核验。保留凭据、配置和数据库。不发布 Worker、网页、下载包或 GitHub Release。

版本升级前的功能修改已通过队列集成回归、原生 CTest 16/16、TypeScript、C++ 格式、测试 ESLint / Prettier；协议保持 1。未调用真实模型验证工具边界处理时机，专项行为通过真实 Agent 与确定性 Codex peer 验证。部署来源、校验摘要与结果在完成后补充，原始证据保存在忽略目录 `.local/deploy-agent-0.6.22/`。
