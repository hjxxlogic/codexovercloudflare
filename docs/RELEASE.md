# 发布操作

## 1. 发布内容

生产网页与 API：`https://r.xlogic.cc`。下载页：`https://r.xlogic.cc/downloads/`。

当前发布为 0.2.0 开发预览版。Worker 与静态网页一起发布；本机 `coc` / `coc-agent` 不在 Cloudflare 执行，以 Ubuntu 20.04、Debian 12 的 Linux x86_64 动态链接包提供。下载页包含源码包、提交 ID 和 SHA256 校验和。

## 2. 构建和打包

先完成开发说明中的单元、TLS、端到端、格式与构建检查，并提交源代码。构建目标系统的二进制；不要在两个发行版间共用 CMake 构建目录。

```bash
npm run build:native
npm run build:web
python3 scripts/package-release.py --build-dir build --platform ubuntu20.04
# 使用 Dockerfile.test 的 Debian 12 镜像编译另一组二进制：
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2'
python3 scripts/package-release.py --build-dir .local/build-container --platform debian12
```

`apps/web/public/_headers` 会随 Vite 构建复制到静态资源目录；其中 `/downloads/*.md` 必须返回 `Content-Type: text/plain; charset=utf-8`，避免浏览器按错误字符集解码中文。

发布文件写入被忽略的 `dist/web/downloads/`。源码包来自当前 `HEAD`，不会打包 `.local/`、凭据或构建缓存。**重新执行 `build:web` 会清空下载文件，必须随后重新打包**。下载包的系统动态库依赖用 `ldd` 检查；用户需安装对应 OpenSSL、Boost.System、SQLite3、libstdc++ 和 CA 证书。

## 3. 生产配置与发布

`wrangler.jsonc` 绑定 `r.xlogic.cc`，关闭 workers.dev / 预览地址。用 `wrangler whoami` 确认当前账号；发布前检查域名没有被其他服务使用。

首次发布时生成独立的随机所有者密钥，至少 32 字符，保存在 `.local/production/owner-secret`，权限 `0600`；不要复用 `.local/owner-secret` 的开发密钥。`.local/production/secrets.json` 使用 `{"OWNER_SECRET":"实际生产密钥"}` 格式，同样设为 `0600`，不能提交。

```bash
node node_modules/wrangler/bin/wrangler.js deploy \
  --secrets-file .local/production/secrets.json \
  --tag v0.2.0 --message 'Release 0.2.0 C++ preview'
```

Wrangler 将密钥作为 secret 与版本一起上传，不把值放入命令行。已有生产环境必须保留原密钥；仅在明确需要轮换时更新。后续普通代码部署会保留云端 secrets，可省略 `--secrets-file`。不要在日志中打印密钥或登录令牌。

## 4. 发布后验证与版本记录

检查 `/api/v1/healthz`、网页资源、未登录访问 `/api/v1/hosts` 返回 401，以及跨域登录请求返回 403。使用独立 CLI 凭据文件验证 C++ 客户端登录、主机列表和退出；不覆盖日常登录文件。校验线上下载包与 `SHA256SUMS` 一致。检查在线手册的响应头包含 `charset=utf-8`，并用真实浏览器确认 `document.characterSet` 为 UTF-8、正文包含“用户手册”，不能仅凭文件字节校验判断浏览器显示正常。

用 `wrangler deployments list` 记录实际部署版本，将结果更新至 `docs/TEST_REPORT.md`。成功后创建 Git 标签 `v0.2.0`。仓库未配置远程时，提交和标签仅存在本机；不能声称已推送到 GitHub。

发布冒烟不等于会话生产验收；DO 休眠唤醒、跨网络会话、部署断线和长期负载仍需单独验证。
