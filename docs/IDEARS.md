# 远程 Codex 初始构想

[文档索引](README.md)

本文保留项目最初设想，文件名沿用历史路径。当前需求见 [项目需求](REQUIREMENTS.md)，实现方案见 [技术架构](ARCHITECTURE.md)。

## 基本需求

服务器没有公网 IP，但可以访问网络，且已安装 Codex。希望从其它设备远程使用该服务器上的 Codex。

## 初始实现构想

- 服务器运行 Codex 管理程序。
- 客户端提供 Codex 代理和网页两种入口：前者保留类似本地操作的体验，后者支持简单交互。
- Cloudflare Worker 与 Durable Objects 负责实时中转。
