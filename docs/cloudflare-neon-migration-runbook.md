# Cloudflare + Neon 迁移执行记录

日期：2026-10-13。源代码基线：`ee7ae5e8a33c4d02319808f1cfb931a7a2e91c26`。

这份操作单记录实际资源和验收结果。密钥、数据库连接串、旧库导出内容和玩家数据不得写入本文或 Git。

## 资源

| 应用   | GitHub               | Cloudflare Worker | Neon 项目                  | Neon production branch  | 正式域名               |
| ------ | -------------------- | ----------------- | -------------------------- | ----------------------- | ---------------------- |
| Avalon | `XTTTZ/avalon`       | `avalon`          | `lucky-butterfly-60587453` | `br-aged-tree-b3seaf66` | `www.avalonxty.site`   |
| Poker  | `XTTTZ/avalon-poker` | `avalon-poker`    | `proud-snow-35074894`      | `br-odd-surf-b3lzyfgb`  | `poker.avalonxty.site` |

两个 Neon 项目均为 PostgreSQL 17、AWS 新加坡 `aws-ap-southeast-1`，当前账号免费规格将计算固定为 0.25 CU；平台不允许本账号自行修改休眠间隔。

Cloudflare zone 为 `2de383921e394cee36e271ec503667ab`，当前状态 `pending`；待注册商切换到 `augustus.ns.cloudflare.com` 和 `katja.ns.cloudflare.com` 后才会激活。切 NS 前已在待激活 zone 中临时保留根域名和 `www` 到 `xtttz.github.io` 的 DNS-only CNAME，避免 DNS 托管切换本身提前改变应用源站。

## 回滚材料

- 源仓库本地 Git bundle：`/tmp/avalon-pre-cloudflare-neon-20261013.bundle`，仅用于本机临时恢复，不属于长期备份。
- Poker 通过 `git subtree split --prefix=apps/poker` 提取，提取提交为 `82a62b7ee100bfe44894b447c007cd218c05de43`。
- CloudBase、GitHub Pages 与原 DNS 在新站验收前保持可回滚；新端开始接收生产写入后，回滚代码仍连接同一 Neon 数据库，禁止直接切回落后的旧库。

## 执行检查

- [x] 记录本地与 GitHub 源 SHA，创建 Git bundle。
- [x] 在独立临时克隆验证旧版 Avalon：129 项单元测试和生产构建通过。
- [x] 在独立临时克隆验证旧版 Poker：45 项单元测试和生产构建通过。
- [x] 保留 Poker Git 历史并建立同级独立仓库。
- [x] 创建两个隔离的 Neon 新加坡项目。
- [x] 创建待激活的 Cloudflare zone，并预置现有 GitHub Pages 回源记录。
- [x] 两仓库格式、类型、单元测试、PostgreSQL 17 权限/迁移、生产构建和 Worker dry-run 通过；Avalon 16 项手机 E2E 通过。
- [ ] 在隔离 Neon 分支预演 schema 与数据导入并核对哈希、revision 和回执。
- [x] 两个预览 Worker 已部署到 `workers.dev`；实测访客登录、建房、加入、WebSocket 版本通知、鉴权/CORS/no-store 和解散清理通过。
- [ ] 冻结 CloudBase 写入，执行最终导出和导入；保留原身份派生与会话密钥。
- [ ] 将 DNS 托管迁移到 Cloudflare，再分别绑定两个自定义域名。
- [ ] 在微信、国内移动网络和海外网络完成真实访问验收。
- [ ] 推送两个 GitHub `main`，验证 CI；最后才开启 `DEPLOY_ENABLED`。
- [ ] 连续观察至少 7 天后再移除旧 CloudBase/Pages 发布依赖。

预览地址：

- Avalon：`https://avalon.avalon-roundtable.workers.dev`
- Poker：`https://avalon-poker.avalon-roundtable.workers.dev`

两个 Neon runtime 登录角色分别为 `avalon_runtime` 和 `poker_runtime`，均为 `NOINHERIT`，只能执行应用函数，不能直接读取权威文档表。正式切流前仍需迁移旧数据与稳定身份密钥；当前预览使用的是隔离的临时身份密钥。

详细设计、免费额度预算和数据迁移约束见 [`repository-split-cloudflare-neon-plan.md`](repository-split-cloudflare-neon-plan.md)。
