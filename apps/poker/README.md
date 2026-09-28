# Poker · 数字筹码

朋友线下聚会使用的移动端德州扑克数字筹码与荷官辅助工具。实体牌和牌型判断在线下完成；应用处理房间、座位、筹码、下注、底池、行动顺序、结算、撤销及整晚统计。

当前代码是可独立安装和构建的 MVP。它位于同仓库 `apps/poker/`，不从 Avalon 根应用导入运行时代码；将来拆仓可整目录搬走。现有 Avalon 暂保留在仓库根目录，避免在 Poker 云端验收前破坏已发布站点。

## 已实现

- 自定义 SB/BB 盲注表、按手数升级和任意下一手盲注；牌组和牌型由线下自行约定。
- 2–10 人响应式环形牌桌、旁观席、入座/暂停/移除/返场、座次和房主转移。
- Button/SB/BB 轮换、全套无限注动作、最小加注、短 All-in 重开和合理快捷金额。
- 无人能继续下注时，荷官一次确认发完公共牌并直接进入 Showdown。
- 主池/多层边池、未跟注退回、分池、余数筹码顺序和每次命令后的筹码守恒校验。
- 房主/玩家/旁观 Dealer 权限，暂停、撤销、作废当前手、人工校正和公开历史。
- Refill/Rebuy 计数、Session Summary、移动端底部操作区、二维码邀请、刷新/后台/断线恢复。

## 本地运行

```sh
npm ci
cp .env.example .env.local
npm run dev
```

打开 `http://localhost:5174/poker/`。API 默认监听 `http://localhost:8788`，本地数据写入 `.data/poker.json`。

```sh
npm run check
```

仓库根目录也提供 `npm run dev:poker`、`npm run build:poker` 和 `npm run check:poker`。Poker CI 位于 `.github/workflows/poker-ci.yml`。

## CloudBase 资源

- 网页路径：`https://www.avalonxty.site/poker`
- HTTP API：`/api/poker`
- 云函数：`poker`
- 清理触发器：`poker-cleanup`
- PostgreSQL 初始化：`cloudbase/migrations/20260928000000_poker_documents.sql`

Poker 使用独立会话密钥、数据库表、函数和构建产物。生产环境设置 `POKER_SESSION_SECRET`、`POKER_IDENTITY_SECRET`、`PG_REST_URL`、`PG_API_KEY`、`ALLOWED_ORIGINS=https://www.avalonxty.site` 及 `ALLOW_GUEST=true`。密钥不得写入代码或 `VITE_` 变量。

`.github/workflows/deploy-poker.yml` 会依次执行 PostgreSQL 迁移、以 ZIP 直传模式部署 `poker` 函数、创建 `/api/poker` 路由并做线上冒烟检查。数据库连接参数从现有 `avalon` 函数读取；Poker 会话密钥首次部署时单独生成，后续从 `poker` 函数保留。

若当前 CloudBase 环境使用同一个静态托管目录，可在仓库根目录生成联合产物：

```sh
npm ci
npm ci --prefix apps/poker
npm run build:site
```

生成结果为 `dist/index.html` 的 Avalon 和 `dist/poker/index.html` 的 Poker。Poker 的 Vite base 固定为 `/poker/`，其资源不会写入 Avalon 的 `/assets/`。
