# 远程Codex
## 基本需求：  
  有一台服务器没有公网IP，但是可以访问网络。在这台服务器上安装好了codex。希望能远程访问codex。
  
## 实现构想
 - 在服务上运行codex管理程序。
 - 在客户电脑上支持两种模式，
    1. codex代理,运行后，就像操作本地codex一样。
    2. 网页版本。进行简单的交互
 - 在cloudflare上运行workers ,使用 Duable Object 技术，对流量进行实时中转
 
  

   