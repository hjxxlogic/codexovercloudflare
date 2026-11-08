# CW 缓存背压修复发布（2026-11-08）

已发布至主站 `https://r.xlogic.cc`，Cloudflare 版本 `5ed983ac-ae83-4f97-b1cb-857ceb0c7e45`。修复普通历史缓存满后浏览位置、草稿及订阅状态争用额度，以及订阅配额异常关闭历史连接的问题。为恢复记录增加有界预留；浏览器真实配额不足时继续在线读取，不确认未持久化内容，不自动删除草稿或原请求。

- 网页源码：`8fc828934a6e8a76474b118a147f3454d109a764`，已推送 GitHub `master`。
- 源码摘要：`1e5bcbdcd6f62418a290e741d7fcb7d67c50275d5ac6d2419571805e96eb71f7`；干净提交，本地构建。
- 用户明确要求提交、跳过 GitHub Actions 并部署；提交含 `[skip ci]`，无对应 Actions 制品或验证，`ciVerified=false`。
- 执行仓库 `scripts/deploy-cloud.py --local-build --commit HEAD --target production --web-only-from .local/deploy-cloud/local-3d84f4036a78046f270376ddef24329a8eea0538-f4e6336e6676-web-only/deployment.json --apply`。
- 网页保持 0.6.16；Worker 执行制品复用已验证的 0.6.15 源码 `54e210ce04b686b818283d629bb0a8f1e6d8180f`。发布前后回读执行模块，`index.js` SHA256 均为 `aa9dcf461dc8e05c88c0543a8ed9aefa6c4b59affd657bea1bc5f147a1033438`。

## 验证与边界

本机 `npm test` 通过（15 项 CTest、37 个 Vitest 文件 / 403 项测试），`npm run test:cache`、完整 `npm run test:ui`、类型检查、网页构建及修改代码的 ESLint / Prettier 通过。手机视口模拟订阅检查点的 `QuotaExceededError` 事务中止，验证历史连接保持、新消息继续显示且模拟任务可提交；此用例进入默认 UI 测试。

部署脚本完成线上健康检查、网页及下载说明静态资源逐字节核对、Worker 执行模块前后摘要核对。健康接口返回 `ok=true`、Worker 版本 `0.6.15`，与复用的执行制品一致。保留已有下载（Linux 0.6.16 / Windows 0.6.15）、变量与 Secret，未安装或重启 Agent，未变更活动任务。未在真实 iPhone / Safari 上执行交互验证。

## 已核对 SHA256

| 文件                       | SHA256                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `index.html`               | `fd33083e93e68bc56ddf0d8eb789ca39c680d4f73b01df6c6a4c3a91821f23cb` |
| `assets/index-BOfA0Blt.js` | `3d9c53c1c47ac2b38e70237a26e60a4e3545fa064d3edf95499b585b5bd4da36` |
| `downloads/index.json`     | `7bdbf45333e53fe1efbacb106c0d4bfa7e1a916123e09602fa49f8468cbbd0cb` |
| `downloads/SHA256SUMS`     | `9371037173eb154e78fdb06f49c3067548ec67502970f958a3d0feb1ec3d16cc` |

完整部署证据位于忽略目录 `.local/deploy-cloud/local-8fc828934a6e8a76474b118a147f3454d109a764-1e5bcbdcd6f6-web-only/deployment.json`，原始日志 `.local/cache-quota-cloud-deploy.log`，手机截图 `.local/ui-stability/cache-quota-mobile.png`；不提交凭据或机器本地证据。手机可先保留输入框文字，再刷新载入新版；仍需释放历史空间时，使用会话“信息 → 本机存储 → 清理本机会话缓存”，保留草稿与待确认请求。
