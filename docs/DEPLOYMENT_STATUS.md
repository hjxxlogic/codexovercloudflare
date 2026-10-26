# 发布状态：0.5.11

更新时间：2026-10-26。Linux musl 全静态发行包已正式发布并部署；原有三个平台继续提供。

## 已发布身份

- 源码 `59bb0debfd2d7c7d34acb286a744be9820e0c187`，标签 `v0.5.11`。旧标签与归档未改写。
- [Actions 40317904673](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40317904673)：四平台、sanitizers、完整 regression 和发布共七个作业全部通过。
- [GitHub Release v0.5.11](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.11)：四平台原生包、源码、SHA256、清单和完整站点包。
- 生产入口：`https://r.xlogic.cc`；Worker `7fff05b9-5611-478d-8529-050295520b66`，UTC 11:59:04 上线，流量 100%。网页、Worker、在线手册和下载均来自该标签。

## 验证结果

- 站点 GitHub digest、五个归档 SHA256、清单与源码身份全部通过；源码归档等于该提交的 `git archive`。
- 六个 Linux 程序在兼容系统验证版本、来源和帮助命令；musl 版没有动态加载器或共享库依赖。实际 musl CLI 对生产执行 HTTPS 更新检查，使用隔离空凭据，返回已是最新版本，未替换程序。Windows 运行验证由 Actions 完成。
- 线上 health 200 / 0.5.11、未授权 hosts 401、跨域管理员登录 403、安全头和手册 UTF-8 通过；全部静态资源与五个归档匹配 CI，HTML 排除 Cloudflare 统计注入后匹配。
- 生产 Chromium 验证双语切换、刷新保留、桌面 / 手机无溢出、管理员登录入口及无页面脚本错误。
- 保留生产 vars、secrets、DO 数据和已有授权，未操作用户主机 / 会话，无真实模型调用。实际模型任务、长期压力和硬件唤醒未在本次生产验证。

证据见 [测试记录](TEST_REPORT.md) 和 [部署元数据](assets/release-0.5.11-2026-10-26/deployment.json)。完整本机产物与日志在忽略目录 `.local/release-0.5.11/`。发布证据另行提交，源码标签保持不变。
