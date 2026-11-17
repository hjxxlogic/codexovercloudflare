# 0.6.25 统一版本发布（2026-11-17）

网页 / Worker 已升级但公共 Agent 下载仍为 0.6.20，导致更新通知目标仍旧；部分主机独立安装了 0.6.23，因此主机列表同时存在两个版本。本次通过 `--publish-downloads` 同步发布网页、Worker 与四平台 Agent / CLI 下载包为 **0.6.25**，并明确更新区域的版本来源与目标。

- 生产目标：https://r.xlogic.cc；Cloudflare Version ID：`127d6d0d-acd2-4b77-83d6-7862a442a9c7`。
- 部署源码：`fd2213c694782e8af6dd41fa7371555e521789b0`；源码摘要：`0e8baba8945ebd78ee44162f6aac8d38cc1efe4f03054974bd31d8130b57edc1`，协议 1。
- [准确提交的 GitHub Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/44034589982) 已完成并成功；六项必需作业全部通过：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。
- 最终网页、Worker、四平台下载及本机 Agent 均使用该 CI 制品，`ciVerified=true`、`localBuild=false`。
- 发布后健康接口：`ok=true`、`version=0.6.25`、`protocol=1`。网页入口、全部构建 assets、主题、下载页、手册、清单和 SHA256SUMS 在线逐字节匹配；四平台安装包与源码归档均重新下载核对 SHA256，`publicAssetBytesMatch=true`。
- 本机 Agent 通过部署脚本确认空闲后安装，备份运行程序并保留配置与数据库；最终运行版本为 0.6.25、提交与上述 CI 相同，中继连接持续验证 120 秒通过。

用户起初授权跳过 Actions，本机曾安装本地构建；随后用户改为要求使用 GitHub Actions 编译。公共下载及最终部署均采用 CI 构建，本机也重新安装了 CI 制品。本地准备不作为最终发行验证依据。

实际发布命令：

```bash
python3 scripts/deploy-cloud.py --commit fd2213c694782e8af6dd41fa7371555e521789b0 \
  --run-id 44034589982 --target production --publish-downloads --apply
python3 scripts/deploy-agent.py --commit fd2213c694782e8af6dd41fa7371555e521789b0 \
  --run-id 44034589982 --local --binary /home/ubuntu/.local/bin/coc-agent \
  --output .local/deploy-agent-0.6.25-ci --apply
```

保留现有变量、Secret、Access、SETTINGS KV、DO 与业务数据。未创建 GitHub Release，未提交模型任务，未广播全体更新通知。按用户选择，由用户在网页点击“通知所有 coc-agent 更新”；目标已变为 0.6.25。其他主机是否完成安装尚未逐台验收，自动更新仍受启用状态、在线与空闲条件控制；Windows 按手册手动安装。

GitHub artifact SHA256（下载后以独立 digest 复核）：

| 制品              | SHA256                                                             |
| ----------------- | ------------------------------------------------------------------ |
| verified-web      | `a66b0bbf2bfb3245e3a0861010584e06f79baea94cf6ea411d66bd9086c70c39` |
| verified-worker   | `4101c96efc792a3c5411061ad6bd22aad677c90a003ece5e7d5e3cdfc645b054` |
| linux-ubuntu20.04 | `6c8affc4536f9794812d041b3eb1e55b783483ca56bef83ee951b7602f3fbe10` |
| linux-debian12    | `d56f8b49f13f810fa637d4c5571fd13c2e838c5292986b16b9bcbc92a655c653` |
| linux-musl        | `91e009d264c0822c6748f7f3177146f847c181fb567e04dcbe9a8da13e7d4c1d` |
| windows-x64       | `fac5a9acbb38e3f2243bee62d81beebf05883299071f5ca384e332da27be3662` |

在线下载归档 SHA256：

| 文件                                       | SHA256                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| coc-0.6.25-linux-x86_64-debian12.tar.gz    | `ea95246a0966066434f6a494524d4597957f9a162fb24a623362ff25f62dd2c9` |
| coc-0.6.25-linux-x86_64-musl.tar.gz        | `beb0986baba4933fb6c26a8158e7920a075b387803efa6cc7d8f95ea026a70ca` |
| coc-0.6.25-linux-x86_64-ubuntu20.04.tar.gz | `81f532250f55e3f1029bee4ccd47151a4052b20bb2811710c5df8add5e5f074c` |
| coc-0.6.25-windows-x64.zip                 | `bac9f7bb5b9b7032ec4155667365dae89f32aa6ce86691fbc35448a95b5adafd` |
| codex-over-cloudflare-0.6.25-source.tar.gz | `c6a176099bf78b122c1fae815c45885615e3b33bb531fc2b73a4ce3a07fb52d5` |

原始证据保存在忽略目录 `.local/deploy-cloud/44034589982/`、`.local/deploy-agent-0.6.25-ci/44034589982/`；凭据不进入发布记录。
