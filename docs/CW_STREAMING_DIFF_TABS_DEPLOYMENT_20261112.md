# 2026-11-12 CW 流式代码差异与同名 Tab 发布

用户明确要求完成后提交、跳过 GitHub Actions 并部署，新增的同名 Tab 需求合并在本次更新中。功能源码 `fe2722a111383480b48ffe2bdcdc019e35aa9aed` 已推送 GitHub `master`，提交带 `[skip ci]`，Actions API 查询运行数为 0。没有本次 Actions URL 或 CI 制品；网页为干净提交的本地构建，`ciVerified=false`。

## 更新行为

- 展开的代码差异从分块 JSON 中即时解码 diff 正文，正确显示换行、引号、反斜杠和 Unicode；后续分块自动续读，避免加载中出现原始 JSON。
- 收起差异或外层工具分组后暂停续读，再展开继续；旧版差异保留到新版首块到达，按 revision 从起点替换，不混接新旧内容，完成后不轮询。复制为当前已加载的 diff 正文。
- 会话标题忽略大小写判重，同名时显示项目工作目录；同目录仍同名时再显示连接项目名。目录／项目更新或关闭其他同名标签时同步更新显示，读屏与关闭按钮采用同一标签。

## 发布与校验

- 目标：[主站 CW](https://r.xlogic.cc)，网页版本保持 0.6.18。
- Cloudflare 版本：`f64b097d-ece8-4d93-a8ac-a0a2464e6d6c`。
- 源码摘要：`14bde66d6dfcb63764efadfce9208591ea6750f29457d58988f83667d76049a8`。
- 复用主站此前部署 `.local/deploy-cloud/local-b14fc42c5e409c3112e39065d54e51772c273dbd-4b1df2cedabb-web-only/deployment.json` 的 Worker 制品，执行代码来源 `76c7056d0589ea7a4345a2ce404e3f060d83e558`，模块发布前后 SHA256 相同。
- 健康回读：`{"ok": true, "version": "0.6.18", "demand": 1, "protocol": 1}`；首页、全部静态资源以及下载说明、主题、手册、清单与校验和逐字节匹配。
- 保留 Worker 执行代码、变量、Secret、Access、DO 与四平台原生下载；未更新／重启 Agent 或 CLI，未提交生产模型任务或触发更新通知。

| 制品                        | SHA256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `index.html`                | `142bbbf8749c4198d96c109f4005d7fbefd3c78f12d977d4b711f474ab82000c` |
| `assets/index-B1ceINiy.css` | `36dd4db3e5ebb575637f7c5b1c47566d6c9a8ac5aa0043b25c5dc0b85a5987a1` |
| `assets/index-D64bgZMs.js`  | `0fcf1bc453564e46d79dd42ff2522256e9f22729e44e42db4391c53c37a13763` |
| 保留 Worker `index.js`      | `f0736810cec048c3e89a5dc25fd440a7ffd0ff448242aab62669b4e5698cc2c7` |

执行命令：

```bash
python3 scripts/deploy-cloud.py --local-build --commit fe2722a111383480b48ffe2bdcdc019e35aa9aed --target production --web-only-from .local/deploy-cloud/local-b14fc42c5e409c3112e39065d54e51772c273dbd-4b1df2cedabb-web-only/deployment.json --apply
```

## 验证与限制

网页构建、TypeScript、完整 ESLint / Prettier、39 个 Vitest 文件 / 436 项测试和完整 `npm run test:ui` 通过，包括延迟差异续块、新版本替换、折叠暂停、无重复读取及同名 Tab 目录／项目显示。没有原生代码变更，本次未重复原生测试。浏览器使用模拟后端；未在生产已登录会话、真实手机或 Safari 上执行交互测试。截图和具体场景见 [测试说明](TEST_REPORT.md)。

本机证据：`.local/deploy-cloud/local-fe2722a111383480b48ffe2bdcdc019e35aa9aed-14bde66d6dfc-web-only/deployment.json`、`.local/cw-diff-tabs-deploy-20261112.log`、`.local/cw-diff-tabs-ui-20261112.log`。本记录作为后续文档提交，不改变线上功能源码身份。
