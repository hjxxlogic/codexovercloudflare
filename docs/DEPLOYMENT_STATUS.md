# 发布状态：0.5.11 候选

更新时间：2026-10-26。Linux musl 全静态构建已完成本地验证，准备提交并推送 `v0.5.11`，由 Actions 构建四个平台并执行完整门禁；通过后部署同一标签站点与 Worker。当前线上仍为以下 0.5.10，实际发布结果稍后更新。

## 上次发布：0.5.10

更新时间：2026-10-26。测试修复已提交，0.5.10 已正式发布并部署。此前 0.5.9 候选的失败与修复经过保留在 [测试记录](TEST_REPORT.md)。

## 已发布身份

- 测试修复：`4dae2e0`；发布源码：`ccc3a28347b045c90856ddbcb982ab0000c2008e`，标签 `v0.5.10`。没有移动旧 `v0.5.9` 标签。
- [GitHub Actions 40313956429](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40313956429)：Ubuntu 20.04、Debian 12、Windows x64、sanitizers、完整 regression 和发布作业全部通过。
- [GitHub Release v0.5.10](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.10)：三平台原生包、源码包、SHA256 与完整站点包。
- 生产入口：`https://r.xlogic.cc`。Worker `44ee79fc-ec0a-4f6e-98c5-5163e16a26ec` 于 UTC 11:25:48 上线，流量 100%；网页、Worker、在线手册和下载包同步到 0.5.10。

## 验证结果

- 下载 CI 站点包后核对 GitHub asset digest、清单身份与四个归档 SHA256；源码包等于该发布提交的 `git archive`。实际四个 Linux 程序的版本、提交、源码摘要、协议与 dirty=false 一致，帮助命令通过；Windows 运行验证由 Actions 完成。
- 线上 health 200 / 0.5.10、未授权 hosts 401、跨域管理员登录 403、安全响应头及手册 UTF-8 通过。JS / CSS、清单、手册、校验和及四个归档与 CI 产物逐字节一致；HTML 排除 Cloudflare 统计脚本注入与标签间空白后相同。
- 生产 Chromium 验证中英文切换、刷新保留语言、桌面 / 手机菜单无溢出、管理员登录入口与无页面脚本错误。管理员 Tab、双主机会话、审批、历史、文件、撤销和重连由完整 CI E2E / UI 验证。
- 保留生产 secrets、vars、DO 数据与已有授权。没有提交生产登录或授权申请，没有操作既有用户主机 / 会话或调用模型。新版 Agent 的名称 / 代理配置及重启要求见 [用户手册](USER_GUIDE.md)。
- 此前跨主机新建会话的 `chat ready` 超时本轮未复现，根因未确认；未放宽超时。E2E 已增加失败截图与状态输出，CI 已增加 UTF-8 错误注释。

永久证据位于 [release-0.5.10-2026-10-26](assets/release-0.5.10-2026-10-26/deployment.json)；详细说明和其他证据链接见 [测试记录](TEST_REPORT.md)。本机下载、验证脚本与部署日志保存在忽略目录 `.local/release-0.5.10/`。发布后的证据另行提交，不改写源码标签或发行归档。
