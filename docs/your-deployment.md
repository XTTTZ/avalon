# 你的阿瓦隆部署操作单

## 已确认的配置

| 项目            | 值                                                              |
| --------------- | --------------------------------------------------------------- |
| GitHub 私有仓库 | [XTTTZ/avalon](https://github.com/XTTTZ/avalon)                 |
| CloudBase 环境  | `avalon-d4gupz2rs904bec10`                                      |
| 地域            | `ap-singapore`（新加坡，国内站账号）                            |
| 数据库          | PostgreSQL，使用 `cloudbase/postgres.sql`                       |
| 网页网址        | `https://avalon-d4gupz2rs904bec10-1327068090.tcloudbaseapp.com` |
| 登录            | guest，同一浏览器保存设备身份                                   |

不用购买域名或注册公众号即可分享网址玩游戏。微信内可打开网址；当前没有 OpenID 登录。请使用同一浏览器、同一网址，清除网站数据、换手机或无痕模式会成为新玩家。

手机首次打开可能先显示腾讯云“页面访问提示”，等倒计时结束，点击 **确定访问** 即可；Cookie 有效时不会反复提示。默认域名由平台定位为开发测试用途，只适合当前小范围验收，无法承诺长期生产可用；移除提示需要自定义域名。[CloudBase 默认域名说明](https://docs.cloudbase.net/service/alias)

体验版是否续期、默认域名的使用限制和免费额度，以 CloudBase 控制台为准；没有额外购买资源。

## 本次已完成（2026-09-17）

- 建立 PostgreSQL 表、事务 RPC 和服务端访问权限。
- 部署 `avalon` Event 云函数、HTTP 路由和每小时清理触发器。
- 发布默认域名网页，完成发布文件校验与认证/CORS 检查。
- 实际云端完成五人游戏：并发投票、匿名汇总、私人笔记隔离、同设备重新登录、刺杀及再来一局；测试记录已清理。
- 本地 73 项测试、8 项手机浏览器测试及生产构建通过。
- 已推送代码至仓库；实际验证 CLI 更新云函数代码，以及默认域名提示后的手机尺寸浏览器登录和刷新。

真实手机的微信浏览器验收尚需你和朋友完成；当前没有公众号 OAuth。

2026-09-18 更新：已在 GitHub 页面确认 [首次自动发布](https://github.com/XTTTZ/avalon/actions/runs/35241237462) 成功，verify/deploy 都通过，总耗时 2 分 52 秒。现有 Secret / Variables 已能用于发布，不必重复配置。

## 新域名 avalonxty.site（2026-09-18）

已通过你当前登录的腾讯云控制台确认：域名已注册成功，使用 DNSPod，尚无解析记录。新注册域名的公共 DNS 委派仍在传播；本次 Google 公共解析查询返回 NXDOMAIN，不能据此认为注册失败。

点击当前 CloudBase 环境的“添加自定义域名”后，平台明确要求升级：**体验版不支持此功能**。弹窗显示个人版优惠价 19.90 元/月、原价 39.90 元/月，实际支付价格以购买页为准。本次未升级、未购买，也未修改 DNS 或线上网址。

可选择以下接法：

| 接法               | 需要做什么                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 继续尽量免费       | Cloudflare Pages 托管网页，继续请求现有 CloudBase HTTP API；配置新网页 origin 的 CORS，再绑定域名。         |
| 全部使用 CloudBase | 先确认套餐、备案和证书条件，由你完成套餐购买；再绑定网页/API 路由、DNS 和 HTTPS。升级并不代表域名立刻可用。 |

Cloudflare Pages 使用 `avalonxty.site` 根域名时，需要把 DNS nameservers 切到 Cloudflare；使用 `www.avalonxty.site` 时可保留 DNSPod，只添加 Pages 给出的 CNAME。必须先在 Pages 添加该自定义域名，再添加对应 DNS，不能只把域名 CNAME 到旧 CloudBase 默认域名。[Cloudflare 域名接入说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)

新域名启用前需更新云函数 `ALLOWED_ORIGINS` 和前端部署配置，保留旧 origin 便于过渡。guest 身份保存在浏览器的对应网站中，换域名会成为新玩家：旧对局继续从旧网址进入，新域名开新局。稳定跨域身份要等以后接入 OpenID。

## 配置 GitHub 自动发布

1. 打开 [仓库 Actions 配置](https://github.com/XTTTZ/avalon/settings/secrets/actions)。
2. 点击 **New repository secret**。
3. Name 填 `CLOUDBASE_API_KEY`。
4. Secret 填你的管理员环境 API Key，点击 **Add secret**。不要提交到代码，也不要填进 Variables。
5. 切换到 **Variables**，点击 **New repository variable**，添加以下五项：

| Name         | Value（直接复制）                                                                        |
| ------------ | ---------------------------------------------------------------------------------------- |
| `TCB_ENV_ID` | `avalon-d4gupz2rs904bec10`                                                               |
| `TCB_REGION` | `ap-singapore`                                                                           |
| `WEB_ORIGIN` | `https://avalon-d4gupz2rs904bec10-1327068090.tcloudbaseapp.com`                          |
| `API_URL`    | `https://avalon-d4gupz2rs904bec10-1327068090.ap-singapore.app.tcloudbase.com/api/avalon` |
| `AUTH_MODE`  | `guest`                                                                                  |

6. 打开 [Actions](https://github.com/XTTTZ/avalon/actions)，左侧选择 **Deploy CloudBase**。
7. 点击 **Run workflow**，选择 `main`，再点绿色按钮。
8. 等待 `verify`、`deploy` 都显示绿色，再打开网页建房。

流程会先测试，再更新云函数代码，检查 API，备份并上传网页。数据库、云函数环境变量和清理触发器保持原配置。提交到 `main` 只跑 CI；点击 Run workflow 或推送 `v*` 标签才发布。

如果左侧找不到工作流，先确认文件已推送到 `main`、仓库 Actions 已启用；如果 GitHub 要求允许 Actions，点击允许。

## 以后修改代码

在终端一行一行执行：

```sh
cd /Users/tianyi/Files/2_Workspace/avalon
git add .
git commit -m "描述这次修改"
git push origin main
```

等 CI 变绿，再按上面的第 6–8 步发布。日常不需要重建表、创建函数或生成身份密钥；遇到明确的 SQL 更新说明时，先按对应升级步骤更新函数。

## 2026-09-18 修复版上线

本节是本轮修复的发布步骤，**不表示这版已经发布**。增加了闲置房间清理与私人笔记续期；本地代码、SQL 和前端必须一起更新。

1. 打开 [CloudBase 控制台](https://console.cloud.tencent.com/tcb)，进入 `avalon-d4gupz2rs904bec10` 环境。
2. 进入 PostgreSQL 的 SQL 编辑器，复制本仓库 [cloudbase/postgres.sql](../cloudbase/postgres.sql) 的全部内容并执行一次。它使用 `CREATE OR REPLACE` 更新函数，保留已有数据；不需要删除表，也不要执行 `tests/` 下的 SQL 测试脚本。
3. 按「以后修改代码」的三条 Git 命令提交、推送本地修复。等该提交的 CI 通过。
4. 在 GitHub Actions 运行 **Deploy CloudBase → Run workflow → main**，等验证和部署都变绿。
5. 手机重新打开网页，新建房间检查：重名被阻止；长按身份按钮不移动；私人昵称在带队顺序和战报一致；刺杀在圆桌操作，不受五秒计时限制。

原来的每小时 `avalon-cleanup` 触发器继续使用。大厅闲置 24 小时、游戏中闲置 48 小时、结局 24 小时后过期，轮询不续期；旧房间在首次有效操作前保留原到期时间。SQL 更新需要先于新云函数，避免旧清理逻辑误删仍活跃房间的私人笔记。SQL 更新可兼容升级前的房间与代码，但不要在已创建新格式房间后随意回退旧云函数。

## API Key 轮换

之前的 Key 已出现在聊天里，建议上线验收后轮换：

1. CloudBase 控制台创建一个新的服务端管理员环境 API Key。
2. 在云函数 `avalon` 的环境变量中，将 `PG_API_KEY` 改为新 Key，保存。
3. 在 GitHub Secrets 中更新 `CLOUDBASE_API_KEY` 为新 Key。
4. 发布一次，并确认网页登录、建房、加入都正常。
5. 再撤销旧 Key。

`SESSION_SECRET`、`IDENTITY_SECRET` 保持原值。它们已随机生成并保存在云函数中，跟部署 Key 是不同的东西；改变身份密钥会影响玩家恢复。

## 手机验收

公众号接入请按 [微信公众号逐步配置](wechat-setup.md) 操作，先核实菜单外链与网页授权权限，再切换登录方式。

让五个人用各自手机打开网页，建房后分享邀请链接，完成一局。过程中测试刷新、切后台、锁屏、Wi-Fi/蜂窝切换，以及退出微信后重新进入。身份应自动隐藏，游戏应恢复原座位。

以后如果要用公众号菜单，先核实该公众号支持的菜单与网页授权权限。菜单入口和 OpenID 登录分别配置；不要在没有可用授权域名时把 `AUTH_MODE` 改成 `wechat`。完整步骤见 [通用指南](deploy-step-by-step.md)。
