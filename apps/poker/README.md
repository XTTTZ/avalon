# Poker · 德州扑克

移动端德州扑克应用。建房时可选择“电子筹码”或“线上发牌”：前者配合实体扑克牌使用，后者由服务端发牌、亮公共牌、判断牌型并自动结算。两种模式共用房间、座位、筹码、下注、底池、行动顺序、撤销及整晚统计。

当前代码是可独立安装和构建的 MVP。它位于同仓库 `apps/poker/`，不从 Avalon 根应用导入运行时代码；将来拆仓可整目录搬走。现有 Avalon 暂保留在仓库根目录，避免在 Poker 云端验收前破坏已发布站点。

## 已实现

- 自定义 SB/BB 盲注表、按手数升级和任意下一手盲注。
- 建房时锁定电子筹码或线上发牌模式；旧房间默认继续使用电子筹码模式。
- 线上模式使用标准 52 张牌；服务端保存洗牌后的私有牌堆，每位玩家只收到自己的底牌。
- 线上模式自动发 Flop/Turn/River、判断七张牌最佳五张组合，并按各主池/边池资格自动处理赢家、平分和余数筹码。
- 公共牌逐张发出；每街结束先收走本街筹码，再显示新公共牌。刷新、撤销不重播旧动画，并适配系统的减少动态效果设置。
- 线上模式的房主与荷官可在两手之间添加、删除、补充机器人；机器人使用自己的底牌和公开信息估算胜率，并结合跟注成本、筹码和下注历史行动。
- 每手结束后可点选自己的任意一张或两张底牌秀出，弃牌/离席玩家同样可操作；机器人强制秀两张。已公开的牌不会随撤销重新隐藏，未公开的牌和牌型不会发给其他玩家。
- 自己的当前牌型全程可见，公开两张牌后其他玩家也可见牌型小字；胜者框金色突出并显示本手净收益，牌面使用四色花色。
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

## 数据过期与清理

机器人行动由服务端在房间轮询时事务执行，每次至多行动一次，并保留约 1.4 秒的思考间隔。无人查看时停止推进，重新进入后继续。撤销回到机器人回合时自动暂停，荷官可纠正后继续；机器人不自动开始下一手。删除机器人会保留其历史与筹码账目。

- 尚未开始过一手牌的房间在最后一次有效操作或前台续活后保留 7 天；开始过牌局的房间保留 30 天。
- 玩家身份在最后一次登录或房间续活后保留 30 天。牌桌内的筹码、成员和历史随房间整体过期，不单独删除某位玩家的账目。
- 房间页面可见时最多每 10 分钟续活一次；普通状态轮询不延长有效期。过期房间再次打开时会清除本机保存的房间号并提示已解散。
- `poker-cleanup` 每天 02:00 删除数据库中的过期房间和玩家身份；每次最多处理 10 批、每批 400 条。

若当前 CloudBase 环境使用同一个静态托管目录，可在仓库根目录生成联合产物：

```sh
npm ci
npm ci --prefix apps/poker
npm run build:site
```

生成结果为 `dist/index.html` 的 Avalon 和 `dist/poker/index.html` 的 Poker。Poker 的 Vite base 固定为 `/poker/`，其资源不会写入 Avalon 的 `/assets/`。
