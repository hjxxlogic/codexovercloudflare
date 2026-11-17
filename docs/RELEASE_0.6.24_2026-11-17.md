# 0.6.24 会话连接生命周期发布

网页在同一会话从启动中更新为就绪时自动建立控制连接；收到会话结束事件后停止旧控制连接与重试，并保留终态提示。

- 生产目标：https://r.xlogic.cc，Worker / 网页版本 `0.6.24`，协议 1。
- 源码提交：`5d9fa1b7869f0ffc18ed5317d71506a645fa5e34`；功能提交 `f7b505f868758e0ab0e39736fadd6479b96446d6`，随后补齐加密队列端到端测试。
- 源码摘要：`f80ad60bbcb30472b2c7c98d9ccc6a07a3b3c825dbeda2e007f364cdcd53b56e`；源码干净，`ciVerified=true`、`localBuild=false`。
- [准确提交的 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/43994494902) 全部六项必需作业成功：regression、sanitizers、Windows x64、Ubuntu 20.04、Debian 12、musl。
- Cloudflare 版本：`0d200161-7763-4a35-9a26-a6b81b7b41a1`。
- 发布后健康接口：`ok=true`、`version=0.6.24`、`protocol=1`；首页、脚本、样式、主题、在线手册和下载清单逐字节核验通过，`publicAssetBytesMatch=true`。

使用已提交的部署脚本，保留现有变量、Secret、Access、KV 和 DO 绑定；既有下载仍为 `0.6.20`，发布前逐包 SHA256 校验并保全。未安装或重启 Agent / CLI，未发布 GitHub Release 或发送自动更新通知，未调用真实模型。

```bash
python3 scripts/deploy-cloud.py --commit 5d9fa1b7869f0ffc18ed5317d71506a645fa5e34 --run-id 43994494902 --target production --apply
```

制品 SHA256（来自 GitHub artifact digest，下载后复核）：

| 制品            | SHA256                                                             |
| --------------- | ------------------------------------------------------------------ |
| verified-web    | `610d0e05419fe95882fb05f509ed6db94370c06ba6e28b08f345cc02b5c01725` |
| verified-worker | `5fff214274d64c6252a7112b6d6114d823184b861600594c28f34a1e12cbb169` |

本地核验通过：会话生命周期旧版对照与修复后专项、完整 UI、导航、多会话、相关 Vitest 49 项、完整加密端到端与完整端到端、TypeScript、lint / 格式与网页构建。首次 CI 的旧队列等待断言与已发布轮内追加行为不符，修正测试后重新推送并等待完整 CI 成功；未绕过门禁。

线上核验覆盖发布身份、健康与资源一致性，未操作用户现有会话复测其具体等待时长。原始机器证据保存在忽略目录 `.local/deploy-cloud/43994494902/`，旧版对照证据位于 `.local/session-lifecycle/`。
