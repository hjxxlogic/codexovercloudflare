# 自动更新配置容错部署记录（2026-11-05）

Agent / CLI 对废弃 `autoUpdate.intervalHours` 输出警告并忽略；无效自动更新选项输出警告、禁用自动更新后继续。JSON 语法、凭据和安全策略等其他校验继续保留。

- 源码提交：`e6f6d4c4ba54aefe4827e22545f7741eff0bfe58`，版本 `0.6.7`，协议 `1`，干净 CI 构建。
- 源码摘要：`db2c7e69faddaca2365f9938dec426aa6c6a12e10182a4b036454ee36b121d95`。
- Actions：[checks #41973560726](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41973560726)，结果 success。regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 均成功；非标签推送的 publish-release 按设计跳过。
- GitHub musl artifact SHA256：`sha256:cdae1fd3da428f000a852653a48ad9eca707590de72145e94b6e796c67b1b364`。包内归档校验和及两端源码身份均由部署脚本核对。
- Agent SHA256：`495520e175e30b7f98199b91dab6556c6e6d337fffb18d29ef73a5b5577a9f4a`。
- CLI SHA256：`232d7b674c8e6f90179a52d1f4f57ac82204cf864114bf1e2736f0ce3e3db412`。
- 目标：本机 ubuntu 用户的 `coc-agent.service`；Agent / CLI 安装目录为 `/home/ubuntu/v2/coc-0.5.12-linux-x86_64-musl/`。目录历史版本名不代表运行版本。
- 部署命令：`python3 scripts/deploy-agent.py --push --push-remote github --local --binary /home/ubuntu/v2/coc-0.5.12-linux-x86_64-musl/coc-agent --client-binary /home/ubuntu/v2/coc-0.5.12-linux-x86_64-musl/coc-client --apply --output .local/config-warning-deploy`。
- Agent 空闲确认后重启；120 秒验证内服务保持 active、PID 稳定且完成中继握手。两端 `--version` 与提交及摘要一致。安装后使用独立配置运行 CLI `hosts`，验证废弃字段输出警告且退出码为 0。
- Agent / CLI 原二进制均已备份；配置、凭据、数据库和任务未由部署脚本改写。CLI 现有进程继续运行原 inode，新命令使用新版。
- 本地验证：11 项 CTest、35 个 Vitest 文件 / 505 项测试；配置、自动更新、部署脚本回归及 lint、C++ 格式、typecheck 通过。
- 本次仅部署上述 ubuntu 目标；未部署 x0–x9 账户，未发布 Worker、网页、公共下载或 GitHub Release。配套配置清理脚本已提交，未对用户实际配置执行清理。
- 机器本地完整证据及备份路径在忽略目录 `.local/config-warning-deploy/41973560726/deployment.json`；下载、部署日志在 `.local/config-warning-deploy.log`。
