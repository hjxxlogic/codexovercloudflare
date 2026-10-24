# 发布操作

## 1. 发布内容与升级

生产网页 / API：`https://r.xlogic.cc`；下载页：`https://r.xlogic.cc/downloads/`。

当前发布 0.3.0 开发预览版。Worker 与网页一起发布；原生包只包含 `coc-agent` / `coc-client`，不再包含 `coc`。提供 Ubuntu 20.04、Debian 12 的 Linux x86_64 动态链接包、源码包、提交 ID 和 SHA256 校验和。

这是不兼容的认证升级。旧 Agent / 客户端凭证和旧管理员 Cookie 不再接受，所有者密钥保留。原生程序需要更新，A 自行重新申请网页批准的登录，CC / CW 对目标 A 分别申请。systemd 改用 `coc-agent run --config ...`。迁移步骤见 [用户手册](USER_GUIDE.md)。项目配置与 SQLite 格式保留，不自动迁移宽权限令牌。

## 2. 验证与打包

完成原生构建、CTest、Vitest、TLS、真实 Wrangler / Chromium 集成、类型与格式检查，以及 Worker dry-run，并提交源码。集成测试须包含角色与目标 A 隔离、多授权、单次领取、长期凭证及撤销已有连接。

```bash
npm run build:native
npm run build:web
python3 scripts/package-release.py --build-dir build --platform ubuntu20.04
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2'
python3 scripts/package-release.py --build-dir .local/build-container --platform debian12
```

不要在宿主与容器之间共用 CMake 构建目录。用 `ldd` 检查目标二进制依赖；用户需对应 OpenSSL、Boost.System、SQLite3、libstdc++ 和 CA 证书。源码包来自当前 HEAD，不包含秘密、状态或构建缓存。

发布文件位于忽略的 `dist/web/downloads/`。**重新运行 build:web 会清空下载包，必须随后重新打包。** `apps/web/public/_headers` 保证在线 Markdown 返回 `text/plain; charset=utf-8`。

## 3. 生产配置与部署

`wrangler.jsonc` 绑定账号和自定义域名，关闭 workers.dev / preview。发布前通过 Wrangler whoami 确认账号，保留已有生产 OWNER_SECRET。

首次配置时使用独立随机所有者密钥，至少 32 字符；`.local/production/owner-secret` 与 `.local/production/secrets.json` 权限均为 0600，不提交。不要打印或在命令参数中传秘密。普通代码部署保留云端 secrets：

```bash
node node_modules/wrangler/bin/wrangler.js deploy \
  --tag v0.3.0 --message 'Release 0.3.0 scoped device authorization'
```

只有初始化或明确轮换密钥时才追加 `--secrets-file .local/production/secrets.json`。

## 4. 发布后验证与记录

验证健康检查、首页、未登录业务请求返回 401、跨域管理登录返回 403；在线手册需核对 UTF-8 响应头、浏览器实际字符集及文档字节。下载两个发行包与源码包，校验 SHA256、包内容只有两个运行程序，并在匹配系统执行 help。

生产授权冒烟只使用明确标记的临时设备和独立凭证文件：申请临时 A，在真实管理网页核对并批准，验证下载的 A 登录；再为该 A 授权 CC / CW，验证各自作用域及管理员接口拒绝。测试后只撤销本次创建的临时授权，不能操作用户真实设备。测试不调用模型；不宣称覆盖生产 Codex 会话与长期负载。

记录实际 Worker 版本、发布源码提交和验证边界到 `docs/TEST_REPORT.md`。创建 `v0.3.0` 标签指向发布源码提交；有远程仓库时推送提交和标签。发布后的证据文档可另行提交，不改写已发布的源码提交。

DO 休眠唤醒、跨网络会话、部署断线和长期压力另行验收。
