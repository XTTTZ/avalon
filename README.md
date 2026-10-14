# 阿瓦隆 · 圆桌

面向朋友线下聚会的手机 Web App。前端使用 React + TypeScript，生产环境使用 Cloudflare Worker、Static Assets、Durable Objects 和 Neon PostgreSQL；不需要自建服务器。

支持 5–12 人、标准与自定义任务规则、全部基础角色、湖中仙女、兰斯洛特、二维码邀请、私人昵称和笔记、断线恢复。身份与任务票等秘密只由服务端按玩家投影，浏览器不会收到整桌秘密。

德州扑克位于独立仓库 [`XTTTZ/avalon-poker`](https://github.com/XTTTZ/avalon-poker)，本仓库只构建和发布阿瓦隆。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。不同浏览器或无痕窗口可模拟不同玩家。本地默认使用 guest 身份和 `.data/` 文件存储，不依赖云端资源。

常用检查：

```sh
npm run format:check
npm test
npm run build
npm run worker:dry-run
npx playwright install chromium
npm run test:e2e
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

- HTTP 操作使用 requestId、phaseKey、revision 和数据库原子提交，网络重试不会重复投票或推进游戏。
- WebSocket 只发送房间实例、对局和版本号；客户端随后重新获取属于自己的状态。连接失败时自动降级为低频 polling。
- Durable Object 不保存权威游戏状态，不广播身份、私人笔记或个人任务票。
- 四位房号可以复用，服务端另用不可复用的房间 instanceId 隔离旧房和新房。

详细边界见 [架构说明](docs/architecture.md)。

## 全新 Cloudflare + Neon 部署

生产环境使用全新的 Neon 数据库和 guest 身份，不导入旧数据。当前目标资源：

| 项目              | 值                                             |
| ----------------- | ---------------------------------------------- |
| Worker            | `avalon`                                       |
| 预发布地址        | `https://avalon.avalon-roundtable.workers.dev` |
| 正式地址          | `https://www.avalonxty.site`                   |
| Neon 项目         | `lucky-butterfly-60587453`                     |
| Neon region       | `aws-ap-southeast-1`                           |
| 数据库 / 运行角色 | `avalon_prod` / `avalon_runtime`               |
| API / WebSocket   | 同源 `/api` / `/ws`                            |

数据库 migration 必须通过 owner 的 direct、non-pooler 连接执行。Worker 使用 `avalon_runtime` 的 pooled 连接；该角色只能执行应用函数，不能直接读写权威表。首次部署前需确保角色已建立，然后执行：

```sh
psql "$NEON_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_avalon.sql
```

GitHub Actions Variables：

- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare account ID。
- `DEPLOY_ENABLED`：配置齐全后设为 `true`，允许 `main` 自动部署。
- `CUSTOM_DOMAIN_ENABLED`：DNS 切换前设为 `false`；Cloudflare zone 激活并准备绑定域名后设为 `true`。

GitHub Actions Secrets：

- `CLOUDFLARE_API_TOKEN`：具备 Worker 发布和自定义域名所需权限的 API Token。
- `NEON_DIRECT_DATABASE_URL`：owner 的 direct 连接串，只供 migration 使用。
- `NEON_DATABASE_URL`：`avalon_runtime` 的 pooled 连接串，只供 Worker 使用。
- `SESSION_SECRET`：至少 32 字节的稳定随机值。
- `IDENTITY_SECRET`：另一个至少 32 字节的稳定随机值。

不要把连接串或密钥提交到 Git，也不要使用 `VITE_` 前缀保存服务端秘密。项目没有 R2 绑定，不需要 R2 S3 凭据；部署 workflow 也不需要 Neon API Key。

DNS 切换前，保持 `CUSTOM_DOMAIN_ENABLED=false`。workflow 会发布并检查 `workers.dev` 地址。Cloudflare zone 激活后，将变量改为 `true` 并重新运行部署；workflow 会向 Wrangler 传入 `--domain www.avalonxty.site`，随后同时检查 `workers.dev` 和正式域名。

逐项步骤和当前资源状态见 [部署操作单](docs/cloudflare-neon-migration-runbook.md)。

## 游戏与隐私要点

- 每次开局分别安全随机打乱玩家顺序和角色；本局按玩家卡顺序循环带队，房主可按现实座位拖动重排。
- 标准 5–10 人遵循官方阵营和任务人数；7 人以上第 4 个任务至少两张失败票才失败；连续 5 次组队被拒绝则邪恶获胜。
- 任务票只公布总数，组队票全员完成后统一公开。
- 身份默认隐藏；松开、超时、离开窗口或切后台会自动遮盖。刺杀入口只在刺客本人主动显示身份后出现。
- 私人昵称和笔记只属于记录者，房主没有额外读取权限。昵称在记录者自己的玩家卡、战报和操作窗口统一替代公开名字。
- 刷新、锁屏、切后台、关闭浏览器或切换网络后，通过本地会话和服务端状态恢复；掉线不会被自动踢出或代投。
- 大厅闲置 24 小时、局中闲置 48 小时、结算后 24 小时到期；读取和笔记编辑不续期。

更改规则或秘密投影时，至少同时验证状态机、API 投影和手机 E2E。大厅不得暴露刺杀等策略性机制，完整说明只放在深层玩法帮助和本人角色信息中。
