# 阿瓦隆 · 圆桌

朋友线下面对面玩的手机 Web App。React + TypeScript；生产使用 **CloudBase 静态托管、普通云函数 HTTP 访问和文档数据库或 PostgreSQL**，无需自建服务器。公众号菜单只是网页入口，本地开发不依赖微信。

支持 5–12 人、全部基础角色、湖中仙女、成对兰斯洛特及阵营变化、自定义任务、二维码邀请、公开名字、私人昵称/推理笔记、秘密身份卡、匿名任务票、断线恢复和再来一局。5–10 人默认标准规则；11–12 人及兰斯洛特玩法明确标为扩展。

## 本地运行

需要 Node.js 22.13+ 或 24 LTS、npm。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

打开 [localhost:5173](http://localhost:5173)。同 Wi-Fi 手机访问电脑的 `http://局域网IP:5173`，开发服务器已监听所有网卡；仅在可信本地网络开发。不同浏览器/无痕窗口代表不同 guest 玩家；同一浏览器刷新或重开恢复同一玩家。游戏资料与本地签名密钥保存在 `.data/`，服务重启后仍保留。生产网页使用 HTTPS。

```sh
npm test                 # 规则、秘密投影、API、事务、身份测试
npm run build            # 类型检查 + 网页 dist/ + 云函数产物
npx playwright install chromium
npm run test:e2e         # 手机尺寸真实浏览器 + 多玩家完整流程
```

## CloudBase 部署

网页也支持 **GitHub Pages + GitHub Actions** 自动发布，游戏后端继续使用 CloudBase。见 [Pages 发布说明](docs/github-pages.md)；推送到 `main` 后先测试，再发布到 [www.avalonxty.site](https://www.avalonxty.site/)。

你的新加坡环境使用 PostgreSQL、默认域名和 guest 登录，请先看 [你的部署操作单](docs/your-deployment.md)。没有公众号或自有域名也可以直接分享网址玩游戏。

第一次部署推荐按 [逐步操作指南](docs/deploy-step-by-step.md) 执行，包含 GitHub 登录、首次上线、公众号接入、CI/CD 配置与回滚。项目已附带 `.github/workflows/ci.yml` 和 `deploy.yml`；日常发布通过 GitHub 手动运行或推送 `v*` 标签，使用 CLI 仅更新云函数代码并发布构建后的网页。

1. 创建 CloudBase 环境并启用静态网站托管。按 [数据库说明](cloudbase/README.md) 配置对应数据库：文档型数据库创建四个集合；PostgreSQL 执行 `cloudbase/postgres.sql`。两种模式均禁止客户端直接访问，数据库只允许服务端读写。
2. 在云函数环境变量设置下面这些值。使用密码管理器生成并保存两个独立随机密钥（至少 32 字节）；不要提交到 Git 或写成 `VITE_` 变量。

| 变量                                  | 值                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `SESSION_SECRET`                      | 会话签名密钥                                                           |
| `IDENTITY_SECRET`                     | 稳定身份派生密钥，后续必须保留；改变会导致玩家身份改变                 |
| `CLOUDBASE_ENV_ID`                    | 环境 ID                                                                |
| `ALLOW_GUEST`                         | 生产 `false`；独立测试环境可临时 `true`                                |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 公众号 AppID / AppSecret                                               |
| `WECHAT_REDIRECT_URIS`                | 例如 `https://avalon.example.com/`，精确到路径和尾斜杠；多个用逗号分隔 |
| `ALLOWED_ORIGINS`                     | 例如 `https://avalon.example.com`，不含尾斜杠；多个用逗号分隔          |

3. 创建 `.env.production.local`（已忽略），配置公开网页变量：

```dotenv
VITE_AUTH_MODE=wechat
VITE_API_URL=https://你的云函数域名/api/avalon
```

4. 构建并部署。安装官方 CLI 后登录（`npm install -g @cloudbase/cli`、`tcb login`）。配置文件不会保存密钥；线上环境变量更新时选择**保留/增量更新**。

```sh
npm run build
npm ci --prefix cloudfunctions/avalon --omit=dev
# 把 YOUR_ENV_ID 替换为实际环境 ID
tcb fn deploy avalon -e YOUR_ENV_ID
tcb hosting deploy dist -e YOUR_ENV_ID
```

项目的 `cloudbaserc.json` 部署 **Event 普通云函数**，入口 `index.main`。在 CloudBase 控制台为它开通 HTTP 访问，路径设为 `/api/avalon`，允许 POST/OPTIONS。依赖先在本地或 CI 安装，连同 `node_modules` 上传，关闭云端安装依赖；避免新加坡环境在线依赖构建失败。不要将本项目部署成需要监听端口的容器/函数型云托管。前端使用应用自己的 Bearer 会话，因此网关无需额外的 CloudBase 用户登录，但函数会严格验证每次请求。

5. 给网页绑定 HTTPS 域名（中国大陆域名按平台要求备案）。为静态 `index.html` 设置不缓存或短缓存，带 hash 的 `/assets/` 可长期缓存；API 必须保留 `Cache-Control: no-store`，不得 CDN 缓存。建议设置站点 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://你的云函数域名; frame-ancestors 'none'; base-uri 'self'`。
6. 为该函数添加名为 `avalon-cleanup` 的每小时定时触发器。函数每次最多删除 400 个过期文档；详见数据库说明。配置 CloudBase 额度/用量提醒。
7. 部署后执行只读检查，再用 5 个真实微信账号完成一局：

```sh
CLOUD_SMOKE_API_URL=https://你的云函数域名/api/avalon \
CLOUD_SMOKE_ORIGIN=https://avalon.example.com npm run smoke:cloud
```

部署接口依据 [云函数部署](https://docs.cloudbase.net/cli-v1/functions/deploy)、[普通函数 HTTP 访问](https://docs.cloudbase.net/service/access-cloud-function)、[静态托管](https://docs.cloudbase.net/cli-v1/hosting) 官方文档。实际云端发布需要自己的账号、环境与域名，仓库不会自动购买资源。

## 微信公众号接入

- 公众号需要具备网页授权权限；在公众号后台确认自身账号的接口权限。
- 在「公众号设置 / 功能设置」配置**网页授权域名**，按微信要求将验证文件放入 `public/` 后重新构建部署。只使用网页授权，不依赖微信 JS-SDK 分享或小程序 OpenID。
- 自定义菜单选择「跳转网页」，URL 填 `https://avalon.example.com/`。
- 用户在微信打开网页后，通过 `snsapi_base` OAuth 获取身份。`code` 仅交给云函数换取 OpenID，AppSecret 和微信 access token 均不发到浏览器。OAuth state 一次性消费并绑定浏览器 verifier；邀请房间号会在跳转后恢复。
- 从分享链接/二维码加入时，先输入公开名字。重开公众号会恢复最近房间、原座位及已提交行动。开发环境用 guest，不会跳微信授权。
- 真机验收：长按身份松开隐藏、锁屏恢复、切后台恢复、关闭重开微信、切 Wi-Fi/移动网、同账号重新授权、多人同时投票。Playwright 覆盖浏览器行为，无法代替微信真机与真实 OAuth 验收。

参考：[微信网页授权](https://developers.weixin.qq.com/doc/service/guide/h5/auth.html)、[CloudBase 公众号 OAuth 说明](https://docs.cloudbase.net/integration/wechat-official-oauth)。本项目自己在云函数完成授权，不需要再安装公众号集成函数。

## 使用与边界

- 房主建房、朋友扫码入座、调整规则、开始。每个人私下查看身份并确认，之后按页面提示选人、全员表决和秘密执行任务。线下讨论不设自动倒计时。
- 新房间使用随机四位房间号，事务检查占用并在冲突时换号，已有房间不会被覆盖；升级前的六位房间仍可恢复和加入。
- 页面上方的「刷新」只同步游戏状态和本人笔记，不重新载入网页，保留所在页面及未保存的笔记草稿。
- 每次点击「开始游戏」都会重新随机排列玩家卡，并独立随机分配角色，包含手动排过序或再来一局的房间；从第 1 位开始，按卡片从左到右循环带队。两次洗牌分别使用服务端安全随机数，顺序或角色碰巧与上次相同也是合法随机结果。房主可在开局后通过「玩家 → 排序」拖动卡片按现实座位调整，点击保存生效，取消则不变；支持手机触屏、鼠标和方向键。
- 5–10 人默认角色按常见参考配置随人数变化：7 人加入奥伯伦，8 人使用一名普通爪牙，9 人换为莫德雷德，10 人同时使用莫德雷德和奥伯伦；5–6 人保留梅林、派西维尔、莫甘娜、刺客核心组合。特殊角色可在自定义规则中调整。
- 局中也可拖动改序，当前队长、身份、已提交的票及私人笔记保持不变；下次轮换从当前队长在新排列中的后一位继续。带队顺序直接看玩家卡，不再单独显示队列或指定队长入口。
- 房主点「踢人」选择玩家；大厅直接确认移除，局中须确认结束本局、公开身份后再移除。被移除者立即失去房间和笔记访问权限，结算保留其公开身份，以及其他玩家各自设置的私人昵称和笔记；再来一局后该位置空出，等新玩家加入。
- 自定义规则中的人数与票数使用大尺寸减号、数字框和加号；数字框可清空后重输，并会在离开输入框时限制到允许范围。
- 结算后每位玩家都可以立即「退出房间」，无需等待房主再开一局；其身份仍留在其他玩家看到的本局结算中。房主在任意阶段可以「解散房间」，全员立即退出，房间和私人笔记作废。
- 身份默认遮盖，卡片和长按按钮位置固定，内容过长时在卡片内部滚动；松开、临时显示超时、切后台和离开窗口都会隐藏。只有有权知道的信息会发到本人设备，结束前不会发送全桌身份。
- 任务票和刺客刺杀都在圆桌页操作，不受五秒身份显示计时限制。刺杀需要选定目标并二次确认。所有队员看到相同按钮，好人失败票由服务端拒绝；只公开总票数。规则区按好人/坏人列出本局角色配置，玩家与角色的对应关系在结束后公开。
- 同房间的公开名字不能重复（忽略大小写、全半角及多余空格）。私人昵称保存后，在自己的圆桌、带队顺序、身份线索、战报和操作弹窗中统一替代公开名字；玩家卡只显示一个名字。昵称、猜测与笔记仅本人可读写，其他玩家和房主没有额外权限；未保存草稿仅在当前页面内。
- 任务票完成后只保留成功/失败总数，不保留个人票历史。组队票在全员完成后公开。已提交票不可修改。
- 开启湖中仙女后，圆桌战报公开初始持有人和历次交接人，方便全桌回看；每次查验得到的好坏阵营仍只发送给当次持有人。
- 掉线不会被自动踢出，也不能代投。活跃游戏中不能直接换人，移除玩家会先结束本局。大厅无操作 24 小时、局中无操作 48 小时、结束后 24 小时自动到期；最后一人离开大厅立即到期，每小时批量清理。加入或有效游戏操作会刷新闲置期限，轮询和写笔记不会续期。活跃房间和再来一局保留私人笔记；房号复用不会串入旧笔记。过期后不可恢复。guest 身份绑定当前浏览器数据，清除数据/无痕退出会丢失；生产使用稳定 OpenID 可重新识别本人。云资源所有者仍可管理数据库，这不是对云管理员的端到端加密系统。
- 前台 4–20 秒自适应 polling，静止时降低频率，后台/离线停止，网络恢复立即同步。12 人持续前台一小时最多约 10,800 次轮询（4 秒保守上界，不含动作和 OPTIONS）；正常讨论会更少。每次轮询 1 次文档读取、0 次写入，版本未变只返回确认。
- 免费环境的额度、资格和续期以 [CloudBase 当前价格页](https://cloudbase.net/pricing) 为准；不能承诺长期零费用。没有自动扩容到付费套餐的代码。

标准规则已核对：同一轮连续五次拒绝组队，坏人直接获胜，不是强制发车。见[原版规则书](https://avalon.fun/pdfs/rules.pdf)。

本次升级 PostgreSQL 环境前，需要先更新清理函数，见[已有环境升级步骤](docs/your-deployment.md#2026-09-18-修复版上线)。

更多：[实施计划](plan.md) · [规则与安全设计](docs/architecture.md) · [数据库运维](cloudbase/README.md)。
