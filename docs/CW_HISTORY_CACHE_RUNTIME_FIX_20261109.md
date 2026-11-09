# 2026-11-09 CW 运行中历史缓存修复发布

按用户要求直接提交，跳过 GitHub Actions，以仓库脚本本地构建发布主站网页。源码提交 `4bfc53cb97bee75b283854b57272286b9e62fc09` 已推送 GitHub，提交使用 `[skip ci]`，该提交没有 Actions 运行；本次 `ciVerified=false`，没有使用本地原生二进制作为验证发布制品。

## 修复行为

实时历史待写批次达到上限时立即提交，避免在 20 ms 定时器触发前误丢下一个事件。缓存配额不足时，统一停止当前会话后续历史写入与持久确认，继续在线读取和发送任务；草稿与命令沿用原有存储检查。最新历史绕过已满缓存读取 Agent。区分配额不足、写入积压及实际存储访问错误，保留具体错误以便辨认真实故障。

## 发布与校验

- 目标：[主站 CW](https://r.xlogic.cc)，网页版本仍为 0.6.18。
- Cloudflare 版本：`e3946585-3e47-43c2-975e-60c215a72628`。
- 源码摘要：`7f6eb924705e52a819dd707c0326c266d6b009e1c64483ca3bb75f154978b32a`。
- `index.html` SHA256：`f0645cc9afa7f806269f84e20bf5e4674f0bc8716e309787bc790b7a744f4bf6`。
- `assets/index-BHq4trrn.js` SHA256：`b9f7bcc3557616a812d5d6178e3db7a2fff39352069ac28487dc0e44d691392c`。
- 保留 Worker `index.js` SHA256：`f0736810cec048c3e89a5dc25fd440a7ffd0ff448242aab62669b4e5698cc2c7`，发布前后均与已验证制品一致。
- 原有四平台下载、Worker 执行代码、变量、Secret 和 Agent 均保留，未重启 Agent、未提交生产测试任务。
- 健康回读：`ok=true`、`version=0.6.18`、协议 1；首页、全部静态资源及下载说明、清单逐字节匹配。

执行命令：

```bash
python3 scripts/deploy-cloud.py --local-build --commit HEAD --target production --web-only-from .local/deploy-cloud/42565345127/deployment.json --apply
```

## 验证与限制

完整 `npm test`：16 项 CTest 与 37 个 Vitest 文件 / 412 项测试通过。真实 Chromium IndexedDB 回归验证连续 650 个不同事件均落盘及检查点完整；手机视口分别模拟订阅检查点和运行中事件的配额失败，确认连接保持、后续历史写入暂停、在线刷新、新消息和任务发送正常。类型检查、修改代码的 ESLint / Prettier、网页构建和 `git diff --check` 通过。

没有在真实 Safari 或用户浏览器上复现具体错误；容量不足仍需通过会话“信息”中的“清理本机会话缓存”释放空间，修复不会自动删除已确认历史、草稿或原请求。旧版不支持的账本格式仍明确拒绝，未引入自动迁移。

本机证据位于忽略路径 `.local/deploy-cloud/local-4bfc53cb97bee75b283854b57272286b9e62fc09-7f6eb924705e-web-only/deployment.json`、`.local/cache-runtime-deploy.log`、`.local/cache-runtime-tests.log`；两张手机截图位于 `.local/ui-stability/cache-quota-subscription-mobile.png` 和 `.local/ui-stability/cache-quota-events-mobile.png`。
