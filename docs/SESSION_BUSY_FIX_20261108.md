# 浏览器关闭后 Session busy 修复

2026-11-08：电脑控制、手机接管并工作、关闭浏览器后新页面再次附着，可能持续收到 `SESSION_BUSY`。原因是持久 `connectionGeneration > 0` 被当作在线状态，即使旧控制流已经移除，也必须显式接管。

EndpointService 改为通过当前可派发连接判断占用，Store 同时保留未消费且未过期票据的预留。断开后的新 claim 获得新 controlEpoch / controlId，保持旧命令隔离；同 claim 或已验证 stream 恢复保持原控制身份。在线页面仍需明确接管，不停止远程任务，不修改凭证、数据库格式或中继协议。

回归覆盖同身份电脑 / 手机的不同 claim、手机接管、旧电脑关闭、新页面遇到在线手机的拒绝、手机关闭后立即附着、未消费票据的预留及到期、仅关闭控制流、端点断开后的持久记录。网页可靠传输相关 3 个 Vitest 文件 / 39 项测试、类型检查和 C++ 格式检查通过；原生完整 CTest 15 / 15 项通过（169.23 秒）。沙箱内首次运行因禁止创建套接字而失败的项目，已在获得执行权限后完整重跑通过。

按用户要求跳过 GitHub Actions，没有 Actions URL 或 CI 通过声明。通过 `scripts/deploy-agent.py --local-build --allow-uncommitted --local --binary /home/ubuntu/v2/coc-0.5.12-linux-x86_64-musl/coc-agent` 首次准备本地 Linux 构建时未替换服务。生产预检报告 2 个活动 runtime、`idle: false`；仓库要求重启活动会话须明确授权。此修复需要更新 Agent。

首次准备包（添加本记录之前的源码快照）：

- 基础提交：`9cadef6946f7368906853ee986dfd62f02b8e5bb`，包含未提交修复，`dirty: true`。
- sourceDigest：`544256a1dc6fa18b4f60188cbff2768ad70fb6073c296fbad5df476ac75f065e`。
- Agent SHA256：`b377d82782a13675fc8369128f2e76cdd13f726abf2b088c6a9435f6fcfecd08`。
- 本机证据：`.local/deploy-agent/local-9cadef6946f7368906853ee986dfd62f02b8e5bb-544256a1dc6f/deployment.json`；`applied: false`、`ciVerified: false`。

用户随后明确授权“允许立即重启”。安装使用 `--local-build --allow-uncommitted --allow-restart-active --apply`，通过独立 systemd 临时服务执行，避免部署进程随目标 Agent 停止而被终止。安装前备份运行中的二进制，安装后由脚本持续验证源码身份、服务 PID 与中继握手 120 秒；最终结果如下。尚未进行生产端到端验证或多平台 CI 验证。

最终安装成功：

- 目标：本机 `coc-agent.service`；Agent `0.6.14` 升至包含修复的 `0.6.16` 本地构建。
- 基础提交：`9cadef6946f7368906853ee986dfd62f02b8e5bb`，修复为未提交源码快照，`dirty: true`，`ciVerified: false`。
- 已安装 sourceDigest：`e8b07653c47405edde55e2f224b51b778206ba33d62afd90a60006c4c870b18d`。
- 已安装 Agent SHA256：`67a7aeb51f1b301d6f284be9552f1fa6161072e76f2c0f456d263de22f5f5a30`；部署后磁盘文件与运行进程 `/proc/1077769/exe` 校验和一致。
- 服务 PID：`2472690` → `1077769`；`active / running`，脚本验证 120 秒内 PID 稳定并完成中继握手，`applied: true`、`connected: true`。
- 备份原运行二进制：`/home/ubuntu/v2/coc-0.5.12-linux-x86_64-musl/coc-agent.backup-20261108T002133748493Z`；保留配置、凭证和数据库；按明确授权重启原 2 个 runtime，验证结束时 runtime 为 0。
- 最终本机证据：`.local/deploy-agent/local-9cadef6946f7368906853ee986dfd62f02b8e5bb-e8b07653c474/deployment.json`。首次独立部署因 systemd PATH 缺少 CMake 在安装前退出；补全 PATH 后成功，未触发回滚。

本记录的最终结果在安装后补写，因此工作区文档内容晚于已安装的 sourceDigest；运行时代码与已验证构建相同。生产验证限于服务、源码身份、校验和及中继连接；跨设备关闭重开路径已通过本地加密端点回归，未在用户真实浏览器中重复执行。
