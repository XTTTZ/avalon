# Cloudflare + Neon 全新部署操作单

日期：2026-10-14。

本次上线从空数据库开始，只使用 guest 身份。不会导入任何旧房间、玩家、会话或私人笔记。密钥和数据库连接串不得写入本文或 Git。

## 目标资源

| 项目                   | 值                                             |
| ---------------------- | ---------------------------------------------- |
| GitHub                 | `XTTTZ/avalon`                                 |
| Cloudflare account     | `0ca76232217115d0b9dd45572c790fa2`             |
| Worker                 | `avalon`                                       |
| workers.dev            | `https://avalon.avalon-roundtable.workers.dev` |
| Neon 项目              | `lucky-butterfly-60587453`                     |
| Neon production branch | `br-aged-tree-b3seaf66`                        |
| Neon region            | `aws-ap-southeast-1`                           |
| 数据库                 | `avalon_prod`                                  |
| 运行角色               | `avalon_runtime`                               |
| 正式域名               | `https://www.avalonxty.site`                   |

Cloudflare zone `avalonxty.site` 的 ID 为 `2de383921e394cee36e271ec503667ab`。zone 激活需要注册商使用 Cloudflare 分配的两个 nameserver：

- `augustus.ns.cloudflare.com`
- `katja.ns.cloudflare.com`

## 1. 本地验证

```sh
npm ci
npm run format:check
npm run worker:types:check
npm test
npm run build
npm run worker:dry-run
npx playwright install chromium
npm run test:e2e
```

所有检查通过后再配置自动部署。

## 2. Neon 初始化

1. 在 Neon 项目中确认数据库 `avalon_prod` 存在。
2. 创建登录角色 `avalon_runtime`，使用独立强密码，并保持 `NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS`。
3. 获取两条连接串：
   - owner 的 direct、non-pooler 连接串，用作 `NEON_DIRECT_DATABASE_URL`；
   - `avalon_runtime` 的 pooled 连接串，用作 `NEON_DATABASE_URL`。
4. 使用 owner direct 连接执行 `migrations/0001_avalon.sql`。migration 会撤销公开表权限，只授予 `avalon_runtime` 三个应用函数的执行权限。
5. 验证 `avalon_runtime` 能调用 `avalon_get`、`avalon_commit`、`avalon_cleanup`，且不能直接查询 `avalon_documents`。

GitHub 部署每次都会幂等执行 `migrations/*.sql`，运行时 Worker 永远不持有 owner 连接串。

## 3. GitHub Actions 配置

Repository Variables：

| 名称                    | DNS 切换前的值                     |
| ----------------------- | ---------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | `0ca76232217115d0b9dd45572c790fa2` |
| `DEPLOY_ENABLED`        | `true`                             |
| `CUSTOM_DOMAIN_ENABLED` | `false`                            |

Repository Secrets：

- `CLOUDFLARE_API_TOKEN`
- `NEON_DIRECT_DATABASE_URL`
- `NEON_DATABASE_URL`
- `SESSION_SECRET`
- `IDENTITY_SECRET`

`SESSION_SECRET` 和 `IDENTITY_SECRET` 使用两个不同的、至少 32 字节的随机值，生成后保持稳定。项目不使用 R2，R2 Access Key 与 Secret Access Key 不得加入仓库。当前 workflow 不调用 Neon 管理 API，因此也不需要保存 Neon API Key。

`production` Environment 可用于保护部署和集中管理环境级 secrets；当前 workflow 同样支持仓库级 Variables 与 Secrets。

## 4. DNS 切换前发布

`CUSTOM_DOMAIN_ENABLED=false` 时，Wrangler 不创建自定义域名，只发布到：

`https://avalon.avalon-roundtable.workers.dev`

推送 `main` 或手动运行 `Deploy Avalon`。workflow 将：

1. 复用 CI 完成格式、类型、单元测试、PostgreSQL 17 schema、生产构建和手机 E2E；
2. 使用 direct URL 执行 migration；
3. 使用受限 runtime URL、guest 身份和稳定密钥部署 Worker；
4. 检查 workers.dev 首页和 `/api/health`。

随后用两台浏览器完成 guest 登录、建房、加入、WebSocket 更新、刷新恢复、投票、结算与解散测试。

## 5. 启用正式域名

1. 在域名注册商处把 nameserver 改为 Cloudflare 分配值。
2. 等 Cloudflare zone 变为 active。
3. 删除会与 Worker 自定义域名冲突的旧 `www` DNS 记录。
4. 将 GitHub Variable `CUSTOM_DOMAIN_ENABLED` 改为 `true`。
5. 手动运行 `Deploy Avalon`。

workflow 会追加 `wrangler deploy --domain www.avalonxty.site`，并同时检查 workers.dev 与以下正式地址：

- `https://www.avalonxty.site/`
- `https://www.avalonxty.site/api/health`

确认 HTTPS、API、WebSocket、邀请链接和手机浏览器均正常后完成切换。

## 6. 回滚与运行观察

- 应用回滚使用 Cloudflare Worker 版本回滚或重新部署已验证的 Git commit。
- schema migration 只允许向前兼容；需要破坏性变更时先建 Neon 分支演练和备份。
- 回滚应用时继续连接同一个 Neon 数据库，避免数据分叉。
- 观察 Worker 请求量、错误、CPU、Durable Object 请求与存储，以及 Neon compute、存储和出站。
- 保持额度和费用告警。朋友局流量很小，但免费额度不是可用性承诺。

## 当前检查点

- [x] Avalon 与 Poker 已拆为独立仓库。
- [x] Worker、Durable Object、Static Assets 和 Neon adapter 已实现。
- [x] Neon 项目、production branch、数据库和受限运行角色已建立。
- [x] workers.dev 预览完成 HTTP、WebSocket、鉴权、CORS 和隐私边界验证。
- [x] 自动部署支持 DNS 切换前只发布 workers.dev。
- [ ] 将完整 Variables 与 Secrets 写入 GitHub。
- [ ] 运行一次新的 `main` 自动部署并验证 workers.dev。
- [ ] 用户切换 nameserver，等待 Cloudflare zone active。
- [ ] 启用 custom domain 并完成正式域名验收。
