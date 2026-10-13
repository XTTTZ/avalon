# 阿瓦隆首次上线与自动发布：逐步操作

按顺序做；每一节的“完成标志”满足后再往下。第一次会配置几个后台，以后更新只需提交代码和点击发布。

项目已经带有两个 GitHub Actions 工作流：`CI` 自动测试，`Deploy CloudBase` 发布网页和云函数。本文采用 GitHub 私有仓库、CloudBase 普通 Event 云函数、文档数据库和静态网站托管。

**你的环境已核实为新加坡 PostgreSQL 环境，请先看 [你的部署操作单](your-deployment.md)，不要重复创建环境或照第 5 节创建文档集合。** 本文保留通用首次配置步骤；PostgreSQL 配置见 [数据库说明](../cloudbase/README.md)。

## 0. 先知道需要什么

| 需要准备                              | 用途                           | 是否要发给 Codex                       |
| ------------------------------------- | ------------------------------ | -------------------------------------- |
| GitHub 账号、仓库地址                 | 保存代码、运行自动发布         | 只需仓库地址；密码和验证码不用发       |
| 腾讯云账号、CloudBase 环境 ID 和地域  | 网页、数据库、云函数运行的位置 | 环境 ID、地域可以提供                  |
| 网页 HTTPS 地址、API HTTPS 地址       | 让网页请求后端                 | 可以提供                               |
| 专用部署子用户的 SecretId / SecretKey | GitHub Actions 登录腾讯云      | 直接填 GitHub Secrets，不发聊天        |
| `SESSION_SECRET`、`IDENTITY_SECRET`   | 保护会话和稳定玩家身份         | 直接填云函数环境变量，不发聊天         |
| 公众号 AppID / AppSecret              | 微信网页授权登录               | AppID 可以提供；AppSecret 直接填云函数 |
| 有网页授权权限的公众号、可配置的域名  | 正式接入微信公众号             | 告诉 Codex 是否具备即可                |

**暂时没有公众号或自有域名也可以先上线测试。** 先使用 CloudBase 默认 HTTPS 域名和 guest 模式；能玩通一局后，再完成第 10 节微信接入。

不必为这个流程购买 GitHub Pro。这里使用仓库级 Secrets / Variables；免费账号的私有仓库不能按前一版建议依赖 GitHub Environments。[GitHub 官方限制说明](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

你的管理员环境 API Key 已通过 CLI 验证，可以部署；优先使用它，只需一个 GitHub Secret。没有此类 Key 时才使用第 11 节的 CAM 子用户方案。前端匿名 `publish_key` 不能用作部署凭据。[CLI 登录说明](https://docs.cloudbase.net/cli-v1/install)

## 1. 打开终端，确认项目位置

Mac 上打开“终端”，复制下面这行，按回车：

```sh
cd /Users/tianyi/Files/2_Workspace/avalon
```

然后运行：

```sh
node --version
npm --version
```

Node.js 应为 24，或者至少 22.13。你现在这台电脑已经能运行项目，不必重新安装 Node。

下面出现 `YOUR_ENV_ID`、`YOUR_REGION`、`YOUR_GITHUB_NAME` 等字样时，**必须替换成自己的值**，不要连占位字一起复制。命令一条一条执行；遇到报错先停在该步。

## 2. 创建空的 GitHub 私有仓库

1. 浏览器打开 [GitHub 新建仓库](https://github.com/new)，登录自己的账号。
2. `Repository name` 填 `avalon`。
3. 选择 `Private`。
4. 不勾选初始化 README，不添加 `.gitignore` 或 License，保持空仓库。
5. 点击 `Create repository`。
6. 复制页面上的 HTTPS 仓库地址，例如 `https://github.com/你的用户名/avalon.git`。

在终端安装 GitHub CLI。你这台电脑已经有 Homebrew：

```sh
brew install gh
gh auth login --hostname github.com --git-protocol https --web
```

按提示在浏览器输入终端给出的验证码并授权。账号密码只在 GitHub 网页输入。

```sh
gh auth setup-git
```

完成标志：`gh auth status` 显示已登录自己的 GitHub 账号。

## 3. 第一次把项目上传 GitHub

本文编写时，这个目录尚未初始化 Git。第一次执行：

```sh
git init -b main
git add .
git status --short
```

检查待提交列表里没有 `.env.local`、`.env.production.local`、`.data/` 或密钥。项目已经配置忽略这些文件。

```sh
git commit -m "Initial Avalon app with CloudBase CI/CD"
git remote add origin https://github.com/YOUR_GITHUB_NAME/avalon.git
git push -u origin main
```

如果提交时提示缺少 `user.name` / `user.email`，在本项目内设置自己的名字和 GitHub 提供的 noreply 邮箱，再执行提交命令：

```sh
git config user.name "你的名字"
git config user.email "你的GitHub邮箱"
```

已有 `.git` 或 `origin` 时，不重复初始化/添加远端；运行 `git remote -v` 确认位置。如果远端仓库已经有代码，先处理合并，别使用强制推送。

浏览器刷新仓库，点击顶部 `Actions`，打开 `CI`。

完成标志：代码已出现，CI 运行成功并显示绿色。首次浏览器依赖安装可能需要几分钟。这一步不需要 CloudBase 密钥，也不会发布线上网站。

## 4. 创建 CloudBase 环境并记下几个地址

1. 打开 [腾讯云 CloudBase 控制台](https://console.cloud.tencent.com/tcb)。首次使用先完成实名认证和服务开通。
2. 创建一个供这个游戏使用的环境，例如显示名称 `avalon-prod`。
3. 根据控制台实际可用的套餐选择资源；确认额度和费用提示后再开通，不必为了 CI/CD 额外创建第二个环境。
4. 找到并记录“环境 ID”，它通常是一串较长的字，不是 `avalon-prod` 这样的显示名称。
5. 记录环境地域。例如上海是 `ap-shanghai`，广州是 `ap-guangzhou`。
6. 开启文档型数据库、云函数、静态网站托管。数据库必须是文档型，而不是 SQL 数据库。
7. 在静态网站托管里复制默认 HTTPS 网站地址，去掉末尾 `/`，作为 `WEB_ORIGIN`。

用自己的笔记记下这个表。这里只填非秘密信息：

| 名称         | 填自己的值                 | 示例                                 |
| ------------ | -------------------------- | ------------------------------------ |
| `TCB_ENV_ID` | 环境 ID                    | `avalon-prod-xxxxxxxx`               |
| `TCB_REGION` | 地域代码                   | `ap-shanghai`                        |
| `WEB_ORIGIN` | 网页地址，不带末尾斜杠     | `https://avalon.example.com`         |
| `API_URL`    | 第 7 节获得的完整 API 地址 | `https://api.example.com/api/avalon` |

完成标志：环境正常，三个服务已开启，已经知道网页地址。API 地址稍后再填。

## 5. 创建四个数据库集合

进入该环境的“文档型数据库 → 集合管理”。逐个创建：

```text
avalon_rooms
avalon_users
avalon_notes
avalon_oauth
```

每个集合都做两件事：

1. 在权限管理中设置“无权限”，或切换到自定义安全规则，填写：

   ```json
   { "read": false, "write": false }
   ```

2. 在索引管理里新建单字段索引：名称 `expiresAt`，字段 `expiresAt`，升序。它保存数值毫秒时间戳；不要设成 Date 类型 TTL。

集合可以保持空白，应用会自己写入文档。[权限设置说明](https://docs.cloudbase.net/database/security-rules)

完成标志：四个集合都存在、都禁止客户端读写、都已有 `expiresAt` 升序索引。

## 6. 第一次创建云函数，设置秘密

终端执行：

```sh
npm install --global @cloudbase/cli@3.8.2
tcb --version
tcb login
```

在浏览器登录腾讯云并同意授权；如果终端提供授权链接和用户码，按提示完成即可。**本地首次部署用浏览器登录，不必提供 SecretKey 给 Codex。**[CLI 登录说明](https://docs.cloudbase.net/cli-v1/install)

```sh
npm ci
npm run build:cloud
npm ci --prefix cloudfunctions/avalon --omit=dev
tcb fn deploy avalon -e YOUR_ENV_ID -r YOUR_REGION --yes
```

命令中的 ID 和地域替换为第 4 节记录的值。这条命令用于首次创建；后面的日常更新用 `code update`。

到控制台“云函数”里找到 `avalon`。它应该是普通 **Event** 函数，运行时 Node.js 20.19，入口 `index.main`，内存 256MB、超时 20 秒。项目配置已指定这些值。

在自己的终端分别运行两次：

```sh
openssl rand -hex 32
openssl rand -hex 32
```

把两串不同的随机值存到自己的密码管理器，然后到 `avalon → 配置/环境变量` 填写：

| 环境变量名         | 首次 guest 测试时填什么                                 |
| ------------------ | ------------------------------------------------------- |
| `SESSION_SECRET`   | 第一串随机值                                            |
| `IDENTITY_SECRET`  | 第二串随机值，长期保留                                  |
| `CLOUDBASE_ENV_ID` | 环境 ID                                                 |
| `ALLOW_GUEST`      | `true`                                                  |
| `ALLOWED_ORIGINS`  | 第 4 节的网页 origin，例如 `https://avalon.example.com` |

保存环境变量并等待配置生效。首次 guest 测试不用填公众号参数。

`IDENTITY_SECRET` 决定玩家身份，以后更新代码不能重新生成它。不要给上述秘密添加 `VITE_` 前缀，也不要填到仓库代码里。

完成标志：`avalon` 已创建，环境变量已保存。控制台直接点“测试”并传 `{}` 被拒绝是正常的，应用需要下面的 HTTP 网关。

## 7. 创建 API 地址

在同一环境进入“HTTP 网关”，或进入 `avalon` 函数详情页的“HTTP 访问”。新建路由：

| 配置         | 值                                                              |
| ------------ | --------------------------------------------------------------- |
| 关联资源     | 云函数                                                          |
| 函数         | `avalon`                                                        |
| 路径         | `/api/avalon`                                                   |
| 请求方法     | `POST`、`OPTIONS`；若只能选全部方法也可使用，应用会拒绝其他方法 |
| 网关登录要求 | 允许匿名经过网关；应用自己校验 Bearer 会话                      |

这里允许访问的是函数入口，数据库权限仍保持关闭。不要选择另一个需要启动 Web Server 的 HTTP 函数类型，也不要把前端指向 `/v1/functions/avalon` 那类需要 CloudBase access token 的 SDK/API 地址。[HTTP 网关说明](https://docs.cloudbase.net/service/access-cloud-function)

复制最终完整地址，必须以 `/api/avalon` 结尾，记入 `API_URL`。如果用默认网关域名，先用默认域名即可。

终端检查，两个地址换成自己的：

```sh
CLOUD_SMOKE_API_URL='https://你的API域名/api/avalon' CLOUD_SMOKE_ORIGIN='https://你的网页域名' npm run smoke:cloud
```

完成标志：看到 `PASS`。它检查未登录读取被拒绝、CORS 正确、秘密响应不缓存；不建房，也不写生产游戏数据。

## 8. 第一次上传网页，先用 guest 玩通

用编辑器在项目根目录新建 `.env.production.local`。文件名完整照写，填：

```dotenv
VITE_AUTH_MODE=guest
VITE_API_URL=https://你的API域名/api/avalon
```

保存后，终端执行：

```sh
npm run build
tcb hosting deploy ./dist -e YOUR_ENV_ID -r YOUR_REGION --safe --verify
```

只上传 `dist/`，不要上传整个项目。网页已经由本地构建，因此这里使用上传现成静态产物的 hosting 命令。[静态发布说明](https://docs.cloudbase.net/cli-v1/hosting)

打开第 4 节的网页地址。创建一个房间，复制邀请链接，用其他浏览器、无痕窗口或朋友手机加入。

完成标志：至少五人能完成一局，刷新后能恢复原玩家和游戏状态。本地 `990080` 存在电脑 `.data/` 中，不会自动迁移到云端；在线上新建测试房间。

## 9. 配置每小时清理

打开 `avalon → 触发器`，新增定时触发器：

```text
名称：avalon-cleanup
类型：定时
Cron：0 0 * * * * *
```

这个七字段表达式表示每小时整点执行。触发器名称必须照写。[定时触发器说明](https://docs.cloudbase.net/cloud-function/timer-trigger)

在控制台配置可用的用量/费用提醒。网站 `index.html` 使用短缓存，带 hash 的 `assets/` 可以长缓存；API 不设置 CDN 缓存。

完成标志：清理触发器已启用，额度提醒已配置。

## 10. 接入微信公众号（准备好公众号后做）

1. 登录 [微信公众号后台](https://mp.weixin.qq.com)，确认这个公众号有网页授权权限。能放菜单链接不代表一定能获取 OpenID；若权限页没有网页授权，先保持 guest 测试。
2. 给静态网站绑定自己可配置的 HTTPS 域名，并按 CloudBase 控制台提示完成 DNS、证书和所需备案。浏览器能打开后再往下。
3. 在公众号“功能设置 → 网页授权域名”填写纯域名，例如 `avalon.example.com`，不带 `https://` 或路径。
4. 下载公众号要求的验证文件，把文件原样放进项目 `public/`。重新执行 `npm run build` 和第 8 节上传命令。直接访问 `https://你的域名/验证文件名.txt`，确认显示文件内容，再点公众号后台“确认”。
5. 在 `avalon` 云函数环境变量添加或更新：

   | 名称                   | 值                                               |
   | ---------------------- | ------------------------------------------------ |
   | `WECHAT_APP_ID`        | 公众号 AppID                                     |
   | `WECHAT_APP_SECRET`    | 公众号 AppSecret                                 |
   | `WECHAT_REDIRECT_URIS` | `https://你的网页域名/`，有尾斜杠，无 query/hash |
   | `ALLOWED_ORIGINS`      | `https://你的网页域名`，无尾斜杠                 |
   | `ALLOW_GUEST`          | `false`                                          |

6. 把 `.env.production.local` 的 `VITE_AUTH_MODE` 改成 `wechat`，API 地址保持正确，重新构建和上传网页。
7. 公众号自定义菜单设置“跳转网页”，地址填 `https://你的网页域名/`。
8. 真正用微信打开菜单，创建新房间，邀请朋友测试。

如果你希望从其他页面路径打开网页，回调白名单必须与网页 `origin + pathname` 一致。当前推荐始终用根路径 `/`。

guest 和微信身份是不同身份；之前的 guest 测试座位不会自动转换成微信座位。切换后新建正式测试局。[微信网页授权说明](https://developers.weixin.qq.com/doc/service/guide/h5/auth.html)

完成标志：微信里首次打开能登录，关闭微信后重开能恢复；五个真实微信账号完成一局，切后台/锁屏时身份自动隐藏。

## 11. 创建专用 CI 部署子用户

已有可用的管理员环境 API Key 可以跳过本节，直接进行第 12 节。

上面的手动部署已经能使用。下面只做自动化，不需要把 GitHub 密码、腾讯云主账号密码交给工作流。

1. 主账号打开 [腾讯云 CAM 用户列表](https://console.cloud.tencent.com/cam)，“用户 → 用户列表 → 新建用户”。
2. 创建名为 `avalon-ci` 的子用户，开启“编程访问/API 密钥访问”。不需要给它控制台密码。
3. 为该子用户关联专用权限策略。项目提供参考模板 [deploy-policy.example.json](../cloudbase/deploy-policy.example.json)，采用目标环境、`avalon` 函数和两个 COS 存储桶的资源范围。

模板里的值这样找：

| 占位字                   | 替换为什么                                                    |
| ------------------------ | ------------------------------------------------------------- |
| `REPLACE_ENV_ID`         | 环境 ID                                                       |
| `REPLACE_REGION`         | 地域代码                                                      |
| `REPLACE_UIN`            | 腾讯云主账号 ID/UIN，在账号信息里查看                         |
| `REPLACE_APP_ID`         | 腾讯云数字 APPID，在账号信息里查看；不是 `wx...` 公众号 AppID |
| `REPLACE_STORAGE_BUCKET` | 本环境对象存储的完整 bucket 名称                              |
| `REPLACE_HOSTING_BUCKET` | 本环境静态托管的完整 bucket 名称                              |

可用当前浏览器登录态查看资源名称：

```sh
tcb env detail -e YOUR_ENV_ID -r YOUR_REGION
tcb hosting detail -e YOUR_ENV_ID -r YOUR_REGION
```

在自己的编辑器把模板中的占位字全部替换；然后到“CAM → 策略 → 新建自定义策略 → 按策略语法 → 空白模板”，粘贴替换好的 JSON，名称填 `avalon-ci-deploy`，保存并关联给 `avalon-ci`。

模板不是已经验证过的目标环境授权：CloudBase 个人版、平台版及底层资源可能不同，必须用第 13 节实际发布验证。若找不到 bucket/UIN 或不会替换，提供这几个非秘密标识给 Codex，可生成针对你的版本；不必先授予主账号权限。不要用仅有 `tcb:InvokeFunction` 的策略，它只有调用权限，不能发布。[官方环境级 CAM 示例](https://docs.cloudbase.net/cam/access-manage)

这个参考模板允许管理目标 CloudBase 环境，并访问指定的发布存储桶，**不是对目标环境内所有操作的最小权限证明**。它避免给 CI 全账号管理员权限；其他账号资源不应加入策略。

4. 到 `avalon-ci` 子用户详情的“API 密钥”，创建/获取 SecretId 和 SecretKey，保存在自己的密码管理器。
5. 下一节直接把它们粘贴到 GitHub Secrets。不要把值写入仓库或发聊天。

完成标志：专用子用户已创建，策略已关联，部署密钥已安全保存。首次云环境开通由主账号完成，CI 不负责创建账号、购买套餐或修改数据库规则。

## 12. 在 GitHub 填自动发布配置

打开 GitHub 仓库：`Settings → Secrets and variables → Actions`。[GitHub Secrets 操作说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

在 **Secrets** 页点 `New repository secret`，分别添加：

推荐：只添加 `CLOUDBASE_API_KEY`，值为管理员环境 API Key。若采用 CAM 子用户方案，才添加下面两个 Secrets；两种方式任选一种，工作流优先使用环境 API Key。

| Name（完全照写） | Secret                        |
| ---------------- | ----------------------------- |
| `TCB_SECRET_ID`  | `avalon-ci` 子用户的 SecretId |
| `TCB_SECRET_KEY` | 同一个子用户的 SecretKey      |

保存后 GitHub 不再显示原值，这是正常的。这里不需要 GitHub PAT，也不用填写公众号 AppSecret。

切到 **Variables** 页，点 `New repository variable`，逐个添加：

| Name（完全照写） | Value                                       |
| ---------------- | ------------------------------------------- |
| `TCB_ENV_ID`     | 环境 ID                                     |
| `TCB_REGION`     | 地域代码，例如 `ap-shanghai`                |
| `WEB_ORIGIN`     | 最终网页 HTTPS 地址，无末尾 `/`             |
| `API_URL`        | 完整 HTTPS API 地址，以 `/api/avalon` 结尾  |
| `AUTH_MODE`      | 尚未接微信填 `guest`；正式公众号填 `wechat` |

`AUTH_MODE=guest` 时云函数 `ALLOW_GUEST` 必须为 `true`；接入微信授权后改成 `wechat` 与 `false`。没有填 `AUTH_MODE` 时工作流默认 `guest`。

**GitHub 不会读取你电脑的 `.env.production.local`。** 这些 Variables 才是自动构建时的网页配置。换域名时同步修改 GitHub `WEB_ORIGIN`、云函数 `ALLOWED_ORIGINS` / `WECHAT_REDIRECT_URIS`，必要时也修改公众号授权域名。

完成标志：一个环境 API Key Secret（或两个 CAM Secrets）、五个 Variables 都已添加，名称拼写一致。

## 13. 第一次点击自动发布

1. 打开仓库 `Actions`。
2. 左边选 `Deploy CloudBase`。
3. 点击右侧 `Run workflow`。
4. 分支选择 `main`，点击绿色 `Run workflow` 按钮。
5. 打开新出现的运行记录。

你会看到两个任务：`verify` 和 `deploy`。测试成功后才执行部署。流程是：

```text
格式/规则/类型/构建/手机浏览器测试
→ 用 Variables 构建正式网页
→ 用专用密钥登录
→ 更新 avalon 云函数代码
→ 检查 API
→ 备份并校验发布网页
→ 检查网页和 API
```

日常流水线使用：

```sh
tcb fn code update avalon -e YOUR_ENV_ID -r YOUR_REGION --yes
```

它更新代码和入口，保留原来的环境变量及触发器。前一版建议中的 `deploy --force` 会同时涉及配置和触发器，不用于这里的日常发布。[云函数更新说明](https://docs.cloudbase.net/cli-v1/functions/management)

完成标志：整个运行显示绿色，打开线上网页能正常建房。工作流语法、本地构建和命令帮助可以在本地验证；账号权限、网关、云数据库与微信真机只能在这次真实上线时验证。

## 14. 以后更新怎么做

在项目根目录执行：

```sh
git add .
git commit -m "描述这次修改"
git push origin main
```

这会自动跑 CI，**不会自动发布生产**。准备上线时，到 GitHub `Actions → Deploy CloudBase → Run workflow → main` 点击发布即可，发布任务会再测试该次提交。

想留下版本号时，在代码已经推送并测试成功后执行：

```sh
git tag v1.0.0
git push origin v1.0.0
```

推送 `v` 开头的标签会自动发布对应提交。下一次用新标签，如 `v1.0.1`，不要移动已有标签。只有 `main` 或已合入 `main` 的 `v*` 标签允许进入部署。

工作流固定 CloudBase CLI 3.8.2；以后升级工具时先改工作流并验证。游戏更新要兼容正在运行的旧房间和未刷新的手机页面。正式更新尽量选大家没在玩的时间。

完成标志：你能通过一个手动发布或版本标签完成更新，线上密钥没有变化，旧房间还能恢复。

## 15. 出错看哪里，怎么退回上一版

| 现象                                                        | 先检查                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GitHub 没有 `Run workflow`                                  | `deploy.yml` 是否已经在默认 `main` 分支，是否允许 Actions，账号是否有仓库写权限                     |
| `Missing repository variable` / `Missing repository secret` | 第 12 节的名字有没有写错，是否存到了仓库 Actions 配置里                                             |
| 登录失败 / 权限不足                                         | 专用子用户密钥是否对应，策略中的地域、UIN、环境和 bucket 是否正确；记录失败步骤和权限错误，不贴密钥 |
| 环境不存在                                                  | 环境 ID 是否用成显示名称，`TCB_REGION` 是否与目标环境一致                                           |
| 函数类型不匹配                                              | 是否误创建为 HTTP/容器函数；本项目需要普通 Event 函数                                               |
| `smoke:cloud` 失败 / 服务配置未完成                         | 云函数密钥长度、`ALLOWED_ORIGINS`、API 网关完整 URL；网关是否错误要求 CloudBase 登录                |
| 网页能打开，但所有操作失败                                  | `API_URL` 是否含 `/api/avalon`，网页当前域名是否在 `ALLOWED_ORIGINS`                                |
| 微信提示未配置授权/回调不允许                               | 网页授权权限、AppID/AppSecret、精确回调 URL 和尾斜杠                                                |
| guest 测试提示仅允许微信登录                                | `AUTH_MODE` 和云函数 `ALLOW_GUEST` 是否同步                                                         |
| CI 测试红色                                                 | 点失败步骤查看日志；浏览器失败可下载 `browser-test-results`；测试不通过时工作流不会继续部署         |
| CLI 创建配置目录提示 EACCES                                 | 本机 `.config` 属于 root；见下面只创建 CLI 专用目录的处理方式                                       |

把失败的**步骤名和错误信息**提供 Codex 即可，不要复制带密码/密钥的整段配置。

这台 Mac 已检查到 `/Users/tianyi/.config` 属于 root。如果 `tcb login` 提示无法创建 `/Users/tianyi/.config/.cloudbase`，在你自己的终端执行一次：

```sh
sudo install -d -m 700 -o tianyi -g staff /Users/tianyi/.config/.cloudbase
```

它只创建/设置 CloudBase CLI 的专用目录，不递归修改 `.config` 或用户目录。系统密码在本地终端输入，输入时不会显示字符；不需要发聊天。之后正常执行 `tcb login`，不要用 sudo 运行整个发布流程。若报错路径不同，先提供路径再定向处理。

网站上传失败时 `--safe` 会在其支持范围内恢复网站备份；这不等于前后端整体原子回滚。云函数先更新成功、网页后续失败时，要确认兼容性，必要时重新发布上一版。

整体退回上一版：找到上次成功发布的版本标签，例如 `v1.0.0`。`Actions → Deploy CloudBase → Run workflow` 的版本选择中选该标签，再运行。若界面只列分支，可使用已登录的 GitHub CLI：

```sh
gh workflow run deploy.yml --ref v1.0.0
```

旧标签也必须包含这套工作流。回滚会重新测试、构建并发布该版代码，不修改数据库、不重新生成身份密钥。如果新版已经做了不兼容的数据迁移，不能简单回滚，先检查数据兼容性。

## 16. 希望 Codex 帮你继续操作时，提供这份清单

复制下面内容，填知道的项；没有就写“尚未创建”：

```text
GitHub 仓库地址：
GitHub 是否已在本机 gh auth login 登录：
CloudBase 环境 ID：
CloudBase 地域代码：
CloudBase 是否已在本机 tcb login 登录：
网页地址 WEB_ORIGIN：
API 地址 API_URL：
公众号类型，以及是否有网页授权权限：
是否已有可配置的域名：
当前做到第几节，最后一步的结果：
```

需要生成 CAM 策略时，再提供主账号 UIN、数字 APPID、本环境对象存储和静态托管的 bucket 名称。这些是资源标识，不是登录凭据。

本地登录由你在浏览器完成后，Codex 可以使用现有 CLI 登录态继续操作；GitHub / CloudBase 的密钥由你填官方后台。授权可以限定为“帮我推送这个仓库并部署这个环境”，无需交出账号密码。

## 操作参考

- [GitHub CLI 浏览器登录](https://cli.github.com/manual/gh_auth_login)
- [GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [CloudBase 查看环境资源](https://docs.cloudbase.net/cli-v1/envs/basement)
- [本项目数据库与云端说明](../cloudbase/README.md)
- [本项目 README](../README.md)

本文准备的是可执行流程，不代表已经发布到你的云环境。真实首次发布需完成你的登录、资源配置及目标权限验证。
