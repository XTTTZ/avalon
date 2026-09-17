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

体验版是否续期、默认域名的使用限制和免费额度，以 CloudBase 控制台为准；没有额外购买资源。

## 本次已完成（2026-09-17）

- 建立 PostgreSQL 表、事务 RPC 和服务端访问权限。
- 部署 `avalon` Event 云函数、HTTP 路由和每小时清理触发器。
- 发布默认域名网页，完成发布文件校验与认证/CORS 检查。
- 实际云端完成五人游戏：并发投票、匿名汇总、私人笔记隔离、同设备重新登录、刺杀及再来一局；测试记录已清理。
- 本地 73 项测试、8 项手机浏览器测试及生产构建通过。

真实手机的微信浏览器验收尚需你和朋友完成；当前没有公众号 OAuth。GitHub Secret / Variables 仍需按下节填写，自动发布工作流尚未完成真实部署验收。

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

等 CI 变绿，再按上面的第 6–8 步发布。不要重新运行首次建表、创建函数或生成身份密钥。

## API Key 轮换

之前的 Key 已出现在聊天里，建议上线验收后轮换：

1. CloudBase 控制台创建一个新的服务端管理员环境 API Key。
2. 在云函数 `avalon` 的环境变量中，将 `PG_API_KEY` 改为新 Key，保存。
3. 在 GitHub Secrets 中更新 `CLOUDBASE_API_KEY` 为新 Key。
4. 发布一次，并确认网页登录、建房、加入都正常。
5. 再撤销旧 Key。

`SESSION_SECRET`、`IDENTITY_SECRET` 保持原值。它们已随机生成并保存在云函数中，跟部署 Key 是不同的东西；改变身份密钥会影响玩家恢复。

## 手机验收

让五个人用各自手机打开网页，建房后分享邀请链接，完成一局。过程中测试刷新、切后台、锁屏、Wi-Fi/蜂窝切换，以及退出微信后重新进入。身份应自动隐藏，游戏应恢复原座位。

以后如果要用公众号菜单，先核实该公众号支持的菜单与网页授权权限。菜单入口和 OpenID 登录分别配置；不要在没有可用授权域名时把 `AUTH_MODE` 改成 `wechat`。完整步骤见 [通用指南](deploy-step-by-step.md)。
