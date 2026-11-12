# 2026-11-12 CW 多会话与预览滚动部署

用户明确要求提交、跳过 GitHub Actions 并部署。本次仅更新 [主站 CW](https://r.xlogic.cc)，网页版本保持 0.6.18；功能提交 `b14fc42c5e409c3112e39065d54e51772c273dbd` 已推送 GitHub `master`，提交带 `[skip ci]`，Actions API 查询运行数为 0。采用本地网页构建，`ciVerified=false`，没有对应 Actions URL 或 CI 制品声明。

## 行为与范围

支持多个会话 Tab、左右／上下双会话分屏、拖动或键盘调整比例；切换保留独立连接和草稿，打开已有会话复用标签，关闭标签不停止任务，关闭最后一个标签留下空白视图。标签集合和布局不跨页面刷新恢复。修复 Markdown／文本独立窗口长文裁剪及无法滚动的问题，正文支持键盘滚动，顶部工具栏保持可见。浮动错误限制在各自会话面板内。

本次复用原 Worker 执行制品，保留原有变量、Secret、Access、DO 和四平台原生下载。未更新或重启 Agent / CLI，未发送更新通知，未提交生产模型任务。

## 部署与来源

- Cloudflare 版本：`13602dc8-0d0a-401e-b191-27565419b1bd`。
- 网页源码摘要：`4b1df2cedabb0584dc342e89d22a40b4d17adba14aed38b1ef4d64d7ac6a7aee`；来源为干净提交，`dirty=false`。
- Worker 来源：`76c7056d0589ea7a4345a2ce404e3f060d83e558`，复用已核验的历史部署 `.local/deploy-cloud/42565345127/deployment.json`，执行模块 SHA256 发布前后相同。
- 健康回读：`{"ok": true, "version": "0.6.18", "demand": 1, "protocol": 1}`。
- 首页、全部静态资源以及下载说明、主题、用户手册、清单和校验和逐字节匹配发布目录。

| 制品                        | SHA256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `index.html`                | `c9686be2b3596c17b3a12ea5e43fac09febf76d8601bfae7692345c4ca39f16d` |
| `assets/index-C_Fs9gvD.js`  | `725bc3c6107738fa83d97167981442b4bd403a4ea84cc90b677e44e5b316b175` |
| `assets/index-DD0R79Md.css` | `7b8f051073f1de0e56be4d313cef385862e9fbc61c6d6764e876968ccf94d433` |
| `downloads/index.json`      | `63bac51e0f73df55851644c1a344f8ed76833e0c9b2bfbfed6153890f2b7f039` |
| 保留 Worker `index.js`      | `f0736810cec048c3e89a5dc25fd440a7ffd0ff448242aab62669b4e5698cc2c7` |

执行命令：

```bash
python3 scripts/deploy-cloud.py --local-build --commit b14fc42c5e409c3112e39065d54e51772c273dbd --target production --web-only-from .local/deploy-cloud/42565345127/deployment.json --apply
```

首次预检因 Cloudflare OAuth 凭据过期返回 401，在发布前退出；通过 Wrangler 刷新现有登录后重试成功。没有关闭任何验证门禁。

## 验证与限制

本机网页构建、TypeScript、完整 ESLint / Prettier、16 项 CTest、37 个 Vitest 文件 / 418 项测试、完整 `npm run test:ui` 和 `npm run test:markdown` 通过；最后补充的关闭末个标签回归也通过。UI 使用模拟后端，不调用模型。未在真实手机 / Safari 或生产已登录会话执行交互测试。

本机证据：`.local/deploy-cloud/local-b14fc42c5e409c3112e39065d54e51772c273dbd-4b1df2cedabb-web-only/deployment.json`、`.local/cw-multi-session-deploy-20261112.log`；截图和详细测试范围见 [测试说明](TEST_REPORT.md)。本记录是后续文档提交，线上功能源码身份仍为上述功能提交。
