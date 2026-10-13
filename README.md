# 阿瓦隆 · 圆桌

面向朋友线下聚会的手机 Web App。前端使用 React + TypeScript，生产环境使用 Cloudflare Worker、Static Assets、Durable Objects 和 Neon PostgreSQL；不需要自建服务器。

支持 5–12 人、标准与自定义任务规则、全部基础角色、湖中仙女、兰斯洛特、二维码邀请、私人昵称和笔记、断线恢复。身份与任务票等秘密只由服务端按玩家投影，浏览器不会收到整桌秘密。

德州扑克已经拆到独立仓库 [`XTTTZ/avalon-poker`](https://github.com/XTTTZ/avalon-poker)，本仓库不再构建或发布 Poker。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。不同浏览器或无痕窗口可模拟不同玩家；本地默认使用 guest 身份和 `.data/` 文件存储，不依赖微信或云数据库。

常用检查：

```sh
npm test
npm run build
npm run worker:dry-run
npx playwright install chromium
npm run test:e2e
npm run format:check
```

同一 Wi-Fi 下可在手机打开 `http://电脑局域网IP:5173`。只在可信网络这样测试，正式站必须使用 HTTPS。

## 生产结构

```text
手机浏览器
  ├─ 页面与静态资源 ── Cloudflare Static Assets
  ├─ /api/* ───────── Worker ── Neon PostgreSQL
  └─ /ws ──────────── 房间 Durable Object
                            └─ 只通知已提交的版本变化
```

- HTTP 操作继续使用 requestId、phaseKey、revision 和数据库原子提交，网络重试不会重复投票或推进游戏。
- WebSocket 只发送房间实例、对局和版本号；客户端随后重新获取属于自己的状态。连接失败时自动降级为低频 polling。
- Durable Object 不保存权威游戏状态，不广播身份、私人笔记或个人任务票。
- 四位房号可以复用，服务端另用不可复用的房间 instanceId 隔离旧房和新房。

架构、规则边界和免费额度分析见 [架构说明](docs/architecture.md) 与 [迁移计划](docs/repository-split-cloudflare-neon-plan.md)。

## Cloudflare + Neon 部署

当前目标资源：

| 项目        | 值                           |
| ----------- | ---------------------------- |
| Worker      | `avalon`                     |
| 正式域名    | `https://www.avalonxty.site` |
| Neon region | `aws-ap-southeast-1`         |
| API         | 同源 `/api`                  |
| WebSocket   | 同源 `/ws`                   |

先在本地完成检查，再执行数据库 migration 和 Worker 发布：

```sh
npm ci
npm run check
npm run test:e2e
npm run worker:dry-run

# 使用 Neon owner/migration 连接串，不能使用浏览器变量。
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_avalon.sql

# DATABASE_URL、SESSION_SECRET 等通过 wrangler secret 或 CI 注入。
npm run worker:deploy
```

生产 Secret 至少包括：

- `DATABASE_URL`：权限受限的 SQL 角色 `avalon_runtime` Neon pooled 连接串；只允许执行应用函数，不能直接读表。
- `SESSION_SECRET`：会话签名密钥，至少 32 字节。
- `IDENTITY_SECRET`：稳定身份派生密钥，至少 32 字节；迁移时必须沿用旧值。
- `WECHAT_APP_SECRET`：启用公众号登录后设置。

GitHub Variables 包括 `CLOUDFLARE_ACCOUNT_ID`、`AUTH_MODE`、`DEPLOY_ENABLED`，启用公众号时再添加 `WECHAT_APP_ID`。`ALLOW_GUEST` 会由 workflow 根据 `AUTH_MODE` 写入部署配置；回调地址和允许来源固定在 `wrangler.jsonc`。任何密钥都不能使用 `VITE_` 前缀、提交到 Git 或写入 Actions 日志。

仓库的 `ci.yml` 验证 PR；`deploy.yml` 只在 `main` 上通过 CI 后运行。首次迁移期间保持 GitHub Variable `DEPLOY_ENABLED=false`，完成 Neon 导入、`workers.dev` 验收和域名切换后才改为 `true`。所需 GitHub Secrets/Variables 以 workflow 中的名称为准。

实际资源、回滚点与逐项进度记录在 [迁移执行操作单](docs/cloudflare-neon-migration-runbook.md)。旧 CloudBase 和 GitHub Pages 文档保存在 [`docs/archive/`](docs/archive/README.md)，仅用于观察期回滚。

## 微信公众号

本地开发继续使用 guest，不需要公众号。生产接入步骤见 [微信公众号配置](docs/wechat-setup.md)：

1. 公众号具备网页授权权限后，将 `www.avalonxty.site` 配为网页授权域名。
2. 菜单跳转到 `https://www.avalonxty.site/`。
3. 在 Worker Secret 设置 AppSecret，在普通变量设置 AppID 和精确 redirect URI。
4. 使用真实微信账号验证授权、邀请加入、锁屏恢复、切网和重新进入公众号。

## 游戏与隐私要点

- 每次开局分别安全随机打乱玩家顺序和角色；本局按玩家卡顺序循环带队，房主可按现实座位拖动重排。
- 标准 5–10 人遵循官方阵营和任务人数；7 人以上第 4 个任务至少两张失败票才失败；连续 5 次组队被拒绝则邪恶获胜。
- 任务票只公布总数，组队票全员完成后统一公开。
- 身份默认隐藏；松开、超时、离开窗口或切后台会自动遮盖。刺杀入口只在刺客本人主动显示身份后出现。
- 私人昵称和笔记只属于记录者，房主没有额外读取权限。昵称在记录者自己的玩家卡、战报和操作窗口统一替代公开名字。
- 刷新、锁屏、切后台、关闭微信或切换网络后，通过本地会话和服务端状态恢复；掉线不会被自动踢出或代投。
- 大厅闲置 24 小时、局中闲置 48 小时、结算后 24 小时到期；读取和笔记编辑不续期。

更改规则或秘密投影时，至少同时验证状态机、API 投影和手机 E2E。大厅不得暴露刺杀等策略性机制，完整说明只放在深层玩法帮助和本人角色信息中。
