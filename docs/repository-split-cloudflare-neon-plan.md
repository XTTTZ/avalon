# Avalon / Poker 拆仓与 Cloudflare + Neon 迁移计划

日期：2026-10-13。状态：**执行中**。

本文件保留迁移决策和验收标准；实际资源、命令、结果与回滚点记录在执行操作单。开始执行时的源代码基线为 `ee7ae5e`，并已生成本地 Git bundle。任何尚未通过验收的项目仍按“待完成”处理。

## 1. 推荐方案

将两个应用拆成独立仓库，各自使用一个 **Cloudflare Worker + Static Assets + 房间 Durable Object**，各自连接一个 **Neon Free 项目**。GitHub Actions 负责测试和发布。Neon 保存权威游戏数据；Worker 通过数据库 CAS 函数处理 HTTP 命令，Durable Object（下文简称 DO）处理实时连接、公开版本通知和 Poker 机器人调度，不另存一套权威牌局。

两款游戏都适合接入 WebSocket。建议先保证新平台上的 HTTP 协议、身份和事务正确，再开启 **WebSocket 状态通知 + HTTPS 操作/同步 + 低频轮询兜底**。不必同时重写命令协议。这个方案已经能让双方实时看到行动，并保留现有断线重试能力。

免费作为发布门槛：使用免费套餐、限制后台任务和机器人消耗、实测再切流。可以做到不自动购买付费资源；不能承诺公开网站在任意流量下既永不超额又始终可用。超额时优先限制新建房和非必要功能，绝不靠自动升级付费维持服务。

| 项目              | Avalon                                   | Poker                                          |
| ----------------- | ---------------------------------------- | ---------------------------------------------- |
| 本地目录          | `/Users/tianyi/Files/2_Workspace/avalon` | `/Users/tianyi/Files/2_Workspace/avalon-poker` |
| GitHub            | `XTTTZ/avalon`                           | `XTTTZ/avalon-poker`                           |
| 正式网址          | `https://www.avalonxty.site/`            | `https://poker.avalonxty.site/`                |
| Worker 建议名     | `avalon`                                 | `avalon-poker`                                 |
| Worker 内的 DO 类 | `RoomHub`                                | `PokerRoom`                                    |
| Neon 项目建议名   | `avalon`                                 | `avalon-poker`                                 |
| Neon 区域         | AWS 新加坡，创建时核实可用性             | AWS 新加坡，创建时核实可用性                   |
| HTTP API          | 同源 `/api`                              | 同源 `/api/poker`                              |
| WebSocket         | 同源 `/ws`                               | 同源 `/api/poker/ws`                           |
| 登录              | 保留现有 guest / 微信实现                | 保留现有 guest 实现                            |

DO 类直接导出于各自 Worker，不需要额外部署第三、第四个生产 Worker。两个 Neon 项目各有独立数据库、运行角色、迁移角色和凭据；一个应用不能读取另一个应用的数据。

## 2. 已核实的现状

代码基线为本地提交 `ee7ae5e`（`Compact Poker header and delay floating pending confirmation`），开始核查时工作区干净。本轮没有重跑业务测试，也没有把历史测试通过数量当成当前验证结果。

| 项目            | 核查结果与影响                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub          | `avalon` 为 public；`avalon-poker` 已存在，返回 size=0，当前为 **private**。不擅自改变可见性；执行时再确认没有新提交。                            |
| Poker 独立程度  | `apps/poker` 有 48 个跟踪文件，独立 package/lock、前后端和测试；未发现依赖 Avalon 根业务代码的运行时 import。                                     |
| 隐含配置        | Poker 没有独立 `.gitignore` 和 `.prettierrc.json`，目前继承根配置，拆出时必须补齐。                                                               |
| 当前发布        | 5 个 workflow，分别负责主 CI、CloudBase、Pages、Poker CI、Poker CloudBase。Pages 会构建两款游戏并拼接 `/poker/`。部分 CI 重复执行。               |
| 后端耦合        | Poker 发布脚本从 Avalon 云函数读取 PostgreSQL 配置；两套数据表分开，但仍依赖同一 CloudBase 环境。                                                 |
| 数据访问        | 两款 `PostgresStore` 都调用 CloudBase PostgREST RPC，**不能只把原地址换成 Neon 连接串**。                                                         |
| DNS             | 公网 NS 为 `charcoal.dnspod.net` / `structure.dnspod.net`；`www` CNAME 为 `xtttz.github.io`；查询未返回 `poker` CNAME。其他记录需切换前完整盘点。 |
| Cloudflare      | 当前连接可见范围内未查到 `avalonxty.site` zone；不能据此断言其他账号也没有。当前套餐及共享额度剩余量尚未核实。                                    |
| Neon            | 当前连接按 avalon / poker 搜索均无匹配项目；本轮未创建项目、读取数据库连接串或核查现有 CloudBase 生产数据。                                       |
| GitHub 发布凭据 | GitHub 连接器可见两仓库管理/推送权限；本机 `gh` 未登录。执行前需验证可用于 Git 推送和 Actions Secrets 配置的认证通道。                            |

代码依据主要是根 `package.json`、`.github/workflows/`、`server/{api,store,postgres-store,cloud}.ts`、`cloudbase/postgres.sql`，以及 Poker 的 `src/api/client.ts`、`server/application/api.ts`、`server/domain/{engine,cards,bots}.ts`、`server/infrastructure/` 和部署脚本。

## 3. 拆仓与内容整理

### 3.1 保留历史，避免影响当前线上版本

1. 执行时重新记录源仓库 SHA、远端 HEAD 和未提交改动；先备份 Git 历史及未跟踪的必要文件。备份和环境文件不进入任何仓库。
2. 在临时克隆中按 `apps/poker/` 提取 Poker 的 Git 历史，并将该路径提升为仓库根；建议使用 `git filter-repo`。不在当前 Avalon 原仓库执行历史改写。
3. 将提取结果放到同级 `avalon-poker`。目录如已存在，先核对内容，不覆盖。新仓库添加独立配置、文档和 workflows，记录来源仓库及源 SHA。
4. 验证 Poker 能在不依赖父目录的干净克隆中独立安装、测试和构建；审计提取历史，确保没有 `.env`、数据备份、会话密钥等敏感内容。
5. 推送前再次核对 `XTTTZ/avalon-poker` 为空；只进行普通首次推送，不强推覆盖别人新写入的内容。保持其当前 private 属性。
6. Avalon 通过普通提交删除 `apps/poker` 和联合构建逻辑，保留既有 Git 历史；不强推清洗整个 Avalon 历史。两个项目以后独立版本、独立发布。

**部署先后约束：**整理分支先通过测试，且旧生产发布入口已冻结或改为手动，再同步到各仓库 `main`。首次推送新代码不得意外自动切换正式网站；新部署流水线初始 `DEPLOY_ENABLED=false`，完整验收后才开启。

### 3.2 Avalon 整理清单

- 移除根 package 的 `dev:poker`、`check:poker`、`build:poker`、联合 `build:site`，以及 `scripts/assemble-poker-static.mjs`。
- 删除 Poker 专属 workflows；整理 `.gitignore`、`.prettierignore` 中的 Poker 特例。
- 保留主游戏的源码、shared、单元测试、手机 E2E、规则和微信接入文档。
- README 改成当前运行/部署入口；本计划和历史 `plan.md` 分开，过时部署文档移入 `docs/archive/` 并标注不再使用。
- 在主站保留 Poker 的外部入口及旧 `/poker/` 迁移页面；不再内嵌 Poker 构建产物。
- CloudBase 云函数、脚本和专用依赖在回滚观察期后再清理。`@cloudbase/node-sdk`、`lodash.set` 覆盖和 vendor 包确认无引用后一起删除，不提前移除仍在使用的依赖修补。

### 3.3 Poker 整理清单

- `apps/poker` 原内容提升为新仓库根，移除所有 `--prefix apps/poker`、根目录相对路径和读取 Avalon 配置的逻辑。
- 补 `.gitignore`、`.prettierrc.json`、Node 版本约束、独立 CI、Playwright 配置、部署及恢复文档。
- Vite `base` 从 `/poker/` 改为 `/`；使用同源 `/api/poker`，邀请链接指向新子域。
- 保留筹码模式、线上发牌、机器人、跑马、秀牌、改名和表情；此次基础设施迁移不顺便改玩法或重做 UI。
- 补自己的 `db/migrations/`、Worker 入口、Neon adapter、运行时配置示例。
- 原 `plan.md` 中同仓、同域、CloudBase 的已过时方案归档；新 `plan.md` 只跟踪当前迁移及待办。

两个仓库都忽略 `node_modules`、`dist`、`.data`、`.wrangler`、`.dev.vars*`、本地 `.env*`、测试产物、数据库导出；只提交脱敏 `.env.example`。当前已有本地资料先保留，不用“整理”作为删除用户数据的理由。

## 4. Actions 的目标形态

每仓库采用同样的两文件结构，但彼此不调用对方仓库：

| 文件         | 触发                                | 职责                                                                                 |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `ci.yml`     | PR → main；`workflow_call`          | 安装、格式/类型、单元、数据库、Worker runtime、手机 E2E、打包，生成带 SHA 的发布产物 |
| `deploy.yml` | push main；手动 dispatch（仅 main） | 调用一次 CI → 检查部署开关与当前 SHA → migration → 发布既有产物 → 线上冒烟           |

`ci.yml` 不再单独监听 main push，避免同一 push 同时触发 CI 与部署中的重复 CI。PR 的验证与合并后 main 验证各跑一次是正常的，因为实际提交不同。标签用于标记版本，不再额外触发第二套发布。

- Node 24、npm lockfile、固定 Wrangler 版本；Actions 固定审核过的 commit SHA，并由依赖更新工具维护。
- 默认 `contents: read`；PR 不取得生产 Secrets，不使用 `pull_request_target` 执行 PR 代码。
- 部署序列按仓库独立锁定；生产 migration/deploy 不在中途取消。排队的旧 main SHA 部署前核对远端最新 HEAD，过期则跳过，防止旧版本覆盖新版本。
- 两个仓库单独设置 `production` 配置。首次切流后，日常 main 自动发布；手动部署也必须经过同一套验证。Poker 私有仓库的 Environments/保护规则是否可用需按 GitHub 套餐确认；免费套餐不支持时用仓库级 Secrets、main 条件和部署开关，不为此升级套餐。
- 只部署本次 CI 的同一 SHA 和同一份静态/Worker 产物，不部署时重新拼一个未经测试的版本。增加 `/health` 返回公开 build SHA 和 schema 版本，不查询数据库、不输出密钥。
- 数据库 migration 使用迁移角色、有版本表和部署锁；常规发布只做向后兼容迁移。破坏性数据变更另列执行步骤，不夹在普通发版里。
- 默认本地 PostgreSQL 服务验证 SQL，不让每个 PR 唤醒生产 Neon；Neon staging branch 的真实驱动测试在迁移预演、SQL/adapter 变更或手动验收时执行，结束清理临时 branch。
- 失败截图/trace 短期保留（建议 3 天），产物设置小体积和短保留期，不上传数据库备份或私密游戏响应。

Avalon 沿用现有 PostgreSQL 和手机测试，替换 CloudBase 打包检查。Poker 现有四个测试文件覆盖部分引擎/API/机器人，还需补独立手机和数据库/runtime 测试，不能沿用“主站 E2E 通过”作为 Poker 验收。

Poker 当前为私有仓库，因此 Actions 消耗账号共享的私有仓库免费时长；GitHub Free 当前包含 2,000 分钟/月和 500 MB artifact 存储，实际以账号套餐及其他仓库用量为准。默认只跑标准 Linux runner，避免重复流水线；超额停止运行，不启用付费 runner。Avalon public 的标准 runner 使用免费。[GitHub 官方计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## 5. Cloudflare 与 Neon 改造

### 5.1 每款游戏一个完整 Worker

生产结构为：

```text
手机浏览器
  ├─ 静态页面/JS/CSS ──> Worker Static Assets
  ├─ HTTPS 登录/操作/同步 ──> Worker ──> Neon CAS 函数
  └─ WebSocket ─────────────> 本应用房间 DO（只发公开版本通知）
```

新增标准 `fetch` / `scheduled` 入口及 `wrangler.jsonc`，保留原业务 API 和领域引擎。前端仍然 React + TypeScript + Vite，不需要换框架。

- 静态文件走 Static Assets，只有应用 API、WebSocket 和健康检查入口优先走 Worker。禁止 SPA fallback 把 API 错误或 WS 握手变成 HTML。
- 静态带 hash 文件长期缓存，HTML 短缓存；身份、笔记、牌局和认证响应继续 `no-store`。前后端同源，减少 CORS 和 OPTIONS 开销。[静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- 使用 `nodejs_compat` 核验 `node:crypto`、Buffer 等；把存储接口与 FileStore/CloudBase SDK 实现分开，生产 bundle 不引入本地文件存储。
- HTTP 入口完成校验、鉴权、确定性游戏计算和 Neon CAS 提交；提交成功后才把公开版本号交给房间 DO。Poker 的到期机器人动作由 DO alarm 唤醒同一套服务端规则。DO 使用 SQLite 类型的 namespace，只保存通知和调度所需的少量辅助信息，权威游戏记录仍在 Neon。
- 房间 DO 按应用和不可复用的房间实例标识定位，不只用四位房号。已授权的 HTTP 响应携带非秘密 instanceId；实时票据在服务端重新验证玩家、房号、实例和对局，处理房间到期、解散和房号复用。
- 每款每天一次分批清理，逻辑过期仍在读写时立即生效；迁移前确认批量上限、超时和 UTC 定时配置。原生命周期不变，只调整物理清理频率以减少 Neon 唤醒。

### 5.2 Neon 连接与事务

采用 Cloudflare 官方支持的 `@neondatabase/serverless` HTTP SQL 接口，新建 `NeonStore`。现有读快照 → 计算 → `*_commit` 原子核对全部 revision 并写入的协议可以保留；每次 commit 在数据库内完成，不用在多次 HTTP 请求之间假装持有数据库事务。

本项目现有提交函数适合单次 HTTP SQL 调用，因此先不引入 ORM、Hyperdrive 或数据库长连接。Cloudflare 推荐 Hyperdrive 以获得最低 TCP 延迟，同时也明确支持 Neon serverless driver；当前朋友局流量使用后者可少维护两个连接池资源，并继续让 Neon 自动休眠。需要交互式 SQL 事务或实测延迟不达标时再评估 Hyperdrive；这里的游戏 WebSocket 与 Neon 数据库连接不是同一件事。[Cloudflare Neon 集成](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/) · [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver)

迁移 SQL 要完成以下事项：

- 将已有表、索引、过期字段、`*_get` / `*_commit` / `*_cleanup` 转成各仓库独立版本化 migration。
- 去掉旧平台的 `anon`、`authenticated`、`service_role` 假设和 `NOTIFY pgrst`；撤销 `PUBLIC` 不必要的表和函数权限。
- 建立有限权限应用角色；如函数使用 `SECURITY DEFINER`，固定安全 `search_path`、明确 owner/EXECUTE 权限。管理员/迁移连接串不供游戏请求使用。
- 保留按键排序的 advisory lock、缺失键竞争校验、UUID revision、防删除重建 ABA、失败回调不写入和原子回执。
- 游戏 `expectedVersion`、`phaseKey`、`requestId` 继续有效；用户网络重试必须复用 requestId，不能重复扣筹码或重复投票。
- 后台仅从服务器访问数据库；不为迁移启用浏览器直连 SQL 或额外 Neon Auth/Data API，不改变当前玩家登录方式。

两个项目建议各使用一个 production branch，平时不保持测试分支在线；预演用隔离 staging branch，禁止真实牌局进入测试分支。优先固定 0.25 CU 并保留休眠，实测后再判断是否够用，不默认扩大计算规格。新加坡 PostgreSQL 区域目前为 `aws-ap-southeast-1`。[Neon 区域列表](https://neon.com/docs/introduction/regions)

## 6. WebSocket 设计与可行性

### 6.1 公共协议与隐私

第一版 WS 只通知 `{roomInstanceId, gameId, version}`。浏览器收到更新后通过 HTTPS 获取自己的权限投影；行动仍使用现有 HTTPS 幂等接口。后续如有必要，再把个人投影直接推送到本人连接。

- 在 HTTPS 已认证接口换取短时、单次、绑定用户/房间实例/目标 origin 的 WS ticket；握手核对精确 Origin 和当前成员资格。不要把长期 bearer token 放进 URL。
- ticket 用于握手；连接授权到期、离开、踢出、解散及房间过期时关闭或重新鉴权。未鉴权连接有限超时/数量，不可只验证一次后永远有效。
- 使用 Hibernation API，连接附件只保存恢复所需的最少标识；空闲不写数据库、不用 `setInterval` 维持 DO 常驻。[Cloudflare WebSocket 休眠说明](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- **先 Neon commit 成功，再广播。**广播失败不撤销已成功命令、不生成新 requestId 重发；客户端靠版本恢复。禁止广播原始 RoomState / RoomRecord，禁止复用别人的 RoomView。
- 私人笔记单独保存，不向整桌发送笔记内容或编辑通知。Avalon 匿名任务票、身份线索及 Poker 未公开底牌继续按本人投影；迁移日志不记录私密载荷。
- 刷新、前台恢复、网络变化先拉最新状态再订阅；握手返回当前版本，订阅建立后立即再核对一次，补上首次拉取与订阅之间的更新窗口。处理重复、乱序、漏通知，重连使用带抖动退避；后台暂停，不承诺手机锁屏时连接永远存活。
- WS 正常时活跃页面每 60 秒做一次兜底核对；讨论/大厅长期空闲逐步放慢。WS 失败降级为有上限的自适应 polling，禁止重连风暴和多标签各开无穷连接。
- DO 不是数据库事务锁的替代品。HTTP、机器人 alarm、重放和并发回调全部保留 CAS；缓存只能更新到不低于当前版本的已提交数据。

### 6.2 Avalon

现有前台轮询为 4–20 秒、后台暂停，按房间版本和 gameId 判断变化，适合替换成事件通知。主要工作集中在 Worker/DO 适配、订阅和断线恢复；游戏状态机无需重写。

保持已有隐私交互：刺杀入口只在本人身份页主动显示身份后出现，大厅摘要不新增机制提示；身份默认隐藏，失焦/后台隐藏；私人昵称和笔记不得进入公共推送。

### 6.3 Poker

可行，但工作量高于 Avalon，有三项必须处理：

1. **机器人调度。**当前 get 请求会推进到期机器人，bot 轮询约 1.6 秒，其他活跃阶段约 2.5–3.5 秒。改为受控 DO alarm：一回合只安排必要下一步，重启/重复 alarm 用 requestId 和版本去重；没有真人前台参与时停止安排，避免无人桌整夜自动打牌。后台残留 socket 不代表真人活跃，需要短期前台活动租约；兜底 HTTP 在线时也可续租。租约仅为调度，不持续写 Neon。
2. **CPU。**现有机器人每次 40 次蒙特卡洛采样，七牌评分有组合枚举，特定平分局面另有穷举检查；多跑马/秀牌投影也重复评分。将这些放到房间 DO，做真实 runtime profile；必要时缓存牌型、优化评估器、给机器人设定计算预算。不能降低随机洗牌的安全性或改变结算正确性来省钱。
3. **数据体积。**事件/账本会增长，undo 最多保留 100 帧，当前整份 room JSON 读写且 RoomView 带历史。需要长局体积测试、历史分页/归档方案和大小上限。迁移旧记录时保留完整牌堆、底牌、回执和审计信息，不能拿前端公开视图替代备份。

第一版先保留 HTTP get 的兼容推进作为降级；正式启用 alarm 前消除双重推进，确保 alarm 与 HTTP fallback 走同一幂等执行路径。开关关闭 WS 时，机器人仍必须可用。

## 7. 免费额度预算与上线门槛

以下为 2026-10-13 查询的公开规格，执行前再核账号实际套餐、额度和平台变更。

| 资源            | 免费额度/限制                                                                  | 方案中的使用方式                             |
| --------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Worker 动态请求 | 每账号 100,000 次/日，两个应用共享；普通入口 10 ms CPU/次                      | 静态文件不走动态逻辑；房间计算进 DO          |
| Static Assets   | 直接静态请求免费，不消耗普通动态请求额度                                       | 不对所有静态请求启用 Worker 优先处理         |
| DO 请求         | 100,000/日；HTTP/RPC/alarm 计数，WS 收到消息按 20:1 计费折算，发出消息不计请求 | 按房间连接，不每人建一个常驻计算对象         |
| DO 活跃时长     | 13,000 GB-s/日；每对象按 128 MB 计算                                           | 使用休眠，禁止空桌定时循环                   |
| DO SQLite       | 5,000,000 读行/日、100,000 写行/日、账号总存储 5 GB                            | 少量调度元数据；setAlarm 也计写入            |
| Neon Free       | 100 CU-h/项目/月；1 GB/项目，账号数据库总量 20 GB；公网出站 5 GB/项目/月       | 两项目分别预算，开发分支同样消耗所在项目额度 |
| Neon 分支/休眠  | Free 可有 100 项目、每项目 10 分支；闲置 5 分钟休眠                            | 不常驻 DB 连接，不为监控每分钟查库           |

额度来源：[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)、[Worker 限制](https://developers.cloudflare.com/workers/platform/limits/)、[DO 计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Neon 当前价格表](https://neon.com/pricing.md)。DO 文档另列默认每次调用 30 秒 CPU；不能把普通 Worker 的 10 ms 与 DO 混为一谈，也不能把 DO 宽限当作机器人可以无预算运行的理由。[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)

### 7.1 一个保守的朋友聚会测算

以下是规划假设，不是线上实测：同一天开一桌 12 人 Avalon 和一桌 10 人 Poker，各玩 4 小时；Avalon 每分钟 1 次有效状态变化，Poker 每分钟 10 次（含机器人和社交操作）。

- 若两桌一直每 4 秒 / 3.5 秒轮询，约 `43,200 + 41,143 = 84,343` 次动态请求，尚未计操作、登录、重连；可见“人少”不代表原样轮询一定够。
- 用版本通知后，按每次变化让全桌各同步一次计算：命令 `240 + 2,400`，同步 `240×12 + 2,400×10`，60 秒兜底 `240×22`，合计约 **34,800 次/日**；再为登录、重连和重试留余量。所有 WS upgrade、其他账号应用也要计入。
- 即使保守按两间 DO 全程活跃，`2×4×3,600×0.128 ≈ 3,686 GB-s/日`，低于 13,000；休眠后通常更少。若机器人空桌跑 24 小时或开很多桌，结论不成立。
- 每项目每月玩 8 次、每次 4 小时，以 0.25 CU 估算为 **8 CU-h/月**。每天一次清理若各唤醒 5 分钟，约另加 **0.625 CU-h/月**，另计测试、查询及休眠尾段。24 小时持续查库则约 180 CU-h/月，会超过 100。

Neon 的 5 分钟休眠不是由 WS 连接本身决定，而是由数据库活动决定。只让浏览器和 DO 保持连接，不为心跳查询数据库。[Neon 休眠说明](https://neon.com/docs/introduction/scale-to-zero)

### 7.2 数据出站是第二个重点

上面的请求测算不能直接证明 Neon 免费。若每次同步都从 Neon 取 100 KB 完整记录，单 Poker 每聚会约 24,000 次读取就约 2.4 GB，几次聚会便可超过 5 GB/月。

因此上线前必须测量 **Neon → Worker 的实际结果字节数**，而不只测前端 JSON。优先方案：

- 相同版本的并发同步在房间 DO 合并读取；已提交记录可做短期内存缓存并逐人投影。缓存不是第二套数据库，休眠/重启后从 Neon 恢复，所有房间写入必须经过该 DO，任何外部导入/修复后失效缓存。
- 兜底先查轻量 revision/过期信息，未变化不读整份 JSON；读权限不能因缓存绕过踢出、过期或解散。
- Poker 历史分页，限制客户端每次取回全部战报；服务端长历史与热状态逐步分离。不要每名玩家每个通知都重复读 undo/全部审计。
- 不为了减少读取而把全桌底牌/身份放公共缓存或广播。

### 7.3 发布门槛与保护

- 两桌完整运行、断线重连、十人 Poker 多跑马、机器人密集动作及长历史测试后，记录入口/DO CPU p95 与最大值、请求量、DO 活跃时长、Neon CU-h/存储/出站。
- 建议内部预算上限设为官方额度的 **50%**：两应用合计 Worker 动态请求不超过 50,000/日；每 Neon 项目预测月 compute ≤50 CU-h、存储 ≤0.5 GB、出站 ≤2.5 GB。这是预留余量的验收目标，不是平台硬配额。
- 入口 CPU 不出现超限错误；目标 p95 <5 ms，并记录最大值。未达标先拆计算/优化，不直接切付费。
- 默认限制每款同时活跃房间数、每用户连接数、建房/动作速率；起始可设各 2 桌并按实测调整。机器人仅在有效真人活动期内运行，禁止自动无限新局；控制表情消息频率。
- 提供 `REALTIME_ENABLED`、`BOTS_ENABLED`、`ROOM_CREATION_ENABLED`、维护模式等服务器开关；达到预警先限制新房和机器人/社交消息，不丢弃已经确认的投票或筹码操作。
- 保持 Cloudflare Workers Free 和 Neon Free，不绑定自动升级/付费扩容流程；若现有账号已付费，先核实际共享计费规则，再决定是否能满足零新增费用。监控告警是提醒，不能当作硬性防超支装置。

免费额度用尽时会影响可用性：Cloudflare 相应操作会失败；Neon compute/出站用尽会暂停计算直至下个计费周期或升级，存储上限也会阻止增长操作。因此不能把“免费硬限制”描述成“超额后游戏还能正常进行”。[Neon 免费上限处理](https://neon.com/docs/introduction/plans)

结论：**小规模朋友局采用上述限制后有充足可行性，但“保证免费且可正常玩”的验收必须包含 CPU 和出站测试；未通过就继续优化或限制规模，不承诺原代码直接搬过去就免费。**

## 8. 身份、数据和旧链接迁移

### 8.1 Avalon 同域恢复

继续使用 `https://www.avalonxty.site`，原 localStorage 可保留。必须同时迁移 rooms/users/notes 等数据、revision、room instance、request receipts，并保留 `IDENTITY_SECRET` / `SESSION_SECRET`，才可继续识别原玩家。

OAuth 进行中的短期 state 可在维护时失效并重新发起；不能把新的用户身份派生密钥当成普通部署变量随意重置。首版维持现有认证模式，不顺便强制启用尚未准备好的公众号授权。

### 8.2 Poker 跨子域恢复

原 `www` 的 localStorage `poker.v1.device/session/room/pending` 在 `poker` 子域不可读取。**仅复制数据库和服务端密钥不够。**推荐保留一个旧源迁移入口：

1. 旧 `/poker/` 首先进入主站同源的精简迁移页，读取旧 Poker 持久状态。
2. 用户已有新子域身份时先避免覆盖冲突；无旧数据者直接进入新站。
3. 通过旧源已认证会话向 Poker 的迁移接口申请短时、单次、绑定目标 origin 和浏览器 verifier 的票据；迁移期只为这几个接口放行精确 `www` 来源。
4. 跳转新子域，票据通过 fragment 或受控 postMessage 传递；兑换后立即清除地址中的票据，设置 `Referrer-Policy: no-referrer`。长期 token/device secret 不进入 URL、日志、Git 或 analytics。
5. 服务端需建立新设备凭据到原 userId 的受控绑定，或安全迁移原设备凭据，确保以后 session 过期重新登录仍是原玩家；不能只迁一次 session，半年后又变新玩家。具体选择建议新凭据绑定，旧凭据保留为过渡恢复途径。
6. 迁移最近房间；pending 命令保留原 requestId/phaseKey，先同步回执再决定是否重试，不生成新 ID 重放扣款。

旧 `/poker/?room=NNNN` 保留房号及必要参数；hash 由旧源页面处理，HTTP 重定向读不到 hash。迁移过渡期先保留上述页面，不直接用永久 308 跳过它；稳定后对无需身份迁移的入口再做重定向。微信需实际验证顶层跳转方案，不依赖一定能打开弹窗。

### 8.3 数据搬迁

先做隔离预演，再选没有正在进行牌局的短维护窗口。按应用分别导出原始数据库记录，包含秘密字段和审计，不通过前端 API 导出公开 RoomView 代替全量数据。

最终顺序：冻结旧端全部业务写入及会写入的 get/bot 路径 → 最终导出 → 导入两 Neon 项目 → 校验记录数、规范化 JSON hash、revision、房间版本、玩家映射、筹码守恒和回执 → 切流。

导出工具支持现有 CloudBase 的实际访问方式：能安全直连则做针对表的数据导出；只能 PostgREST 时做经过验证的分页导出，不假设现有 API Key 就能运行 `pg_dump`。文件放私有临时目录、加密保管，不放仓库或 Actions artifacts。

旧客户端可能仍运行缓存 JS 并访问原 CloudBase API。切换后旧 API 要明确拒绝写入并提示更新；过渡版本先具备维护/迁移错误处理。直到新数据迁移完成且旧端写入已封锁，才能开放新端写入，避免两套数据库分叉。

## 9. 域名与部署切换

Workers Custom Domain 要求 Cloudflare 的 active zone，目前 DNS 仍在 DNSPod，所以本次包含 DNS 托管迁移。**域名注册商仍可保留腾讯云**，不需要转移域名所有权。[Cloudflare 自定义域名要求](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

1. 盘点并备份全部 DNS 记录、TTL、DNSSEC/DS、CAA、MX/TXT 及现有 HTTPS 设置。
2. 在用户指定 Cloudflare 账号添加 zone，将原 DNS 记录完整复制；先维持 `www → GitHub Pages`，不要一改 NS 就顺便切应用。
3. 按 Cloudflare 分配的 NS 到腾讯云调整；DNSSEC 按迁移要求处理旧 DS，待 zone active、新解析和原站访问都正常，再进入应用切换。
4. 先用两个 Worker 的 `workers.dev` 地址和隔离 Neon 数据验收。普通 PR 用本地 runtime，不每个 PR 新建生产 Worker。
5. 正式切流时解除目标 hostname 的旧 CNAME 冲突，分别绑定 `www.avalonxty.site` 和 `poker.avalonxty.site` 的 Worker Custom Domain，等待证书与 HTTPS 生效。
6. 根域名 `avalonxty.site` 如原来跳转 `www`，继续保留该行为；可用同一个 Avalon Worker 或免费重定向规则，不新建第三个应用。
7. 核验邀请链接、旧 Poker 入口、资源路径、API/WS、缓存、微信访问和证书；随后停用旧 Pages 自动发布和 CloudBase 自动发布，保留回滚资料。

Cloudflare 国际网络并不能保证中国大陆每个运营商都低延迟。正式切流前要用实际朋友的移动网络/Wi-Fi 和微信做测试；若连接质量明显不合格，暂缓切域名，保留现有站点，而不是以部署成功代替可玩性验收。

## 10. 分阶段执行与验收

以下全部待执行，不因本计划写完而视为完成。

| 阶段                 | 操作                                                               | 通过标准                                                 |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| A. 基线与备份        | 复核 Git/远端/账号，锁定源 SHA，运行现有检查，准备私密备份         | 现有失败有记录；可恢复源代码、DB、必要身份密钥           |
| B. 独立仓库          | 提取 Poker 历史，建立同级目录，补配置，清理 Avalon，冻结旧自动发布 | 两个干净克隆能独立运行，双方不读对方文件/Secret          |
| C. Actions 与 GitHub | 建两套独立 workflows，默认禁止生产 deploy，再普通推送              | GitHub 与本地 SHA 对应，CI 成功，未切线上                |
| D. 新平台 HTTP       | Worker/DO adapter、NeonStore/SQL、两个 Free 项目、隔离预演         | 游戏/数据库/身份/隐私行为与原版相同，真实 runtime 可运行 |
| E. 实时与预算        | 接 WS、Poker alarm、缓存与体积控制，完成成本测试                   | 两款断线/后台恢复正确，CPU/请求/Neon用量达门槛           |
| F. 迁移预演          | 测全量导入、旧session、Poker跨域身份、pending回执、旧链接          | 原玩家身份和历史保留，未重复操作，迁移可重试             |
| G. 正式切流          | DNS先迁托管；维护窗冻结旧写、最终导入、绑定两个域名                | 域名/证书/健康SHA/隐私/完整游戏及微信真机通过            |
| H. 观察与清理        | 观察至少7天，开启独立main自动发布，整理旧配置                      | 无身份丢失/双写/超额；README只保留当前部署方式           |

生产迁移开始前，计划要转成逐步运行单，写清本次实际资源 ID、回滚版本和每一步结果；所有凭据只通过 Secret/受控环境注入。

### 必要验收场景

- Avalon：5–12 人、随机发身份与座位、并发投票、任务票匿名、保护轮、拒绝阈值、湖中仙女历史、私密笔记、踢人/解散、刺杀入口隐私和后台隐藏。
- Poker：筹码总量、边池/平分、多跑马、秀牌可见性、机器人与真人并发、身份恢复、pending 重放、改名/表情不破坏 phaseKey、十人手机卡片不挡底池。
- 通信：休眠唤醒、重启、重复/乱序/漏通知、断网切前台、跨房间访问拒绝、被踢出撤销、四位房号复用不串局、多标签连接上限。
- 数据：真实 PostgreSQL 的缺失键冲突、CAS、回执原子性、过期清理、私人笔记保留、导入导出往返校验；冷启动、慢查询和提交结果未知时重试。
- 发布：错误 API 不返回 HTML、JS/CSS 正确缓存、秘密响应 no-store、生产 build SHA 正确、源码/产物/日志中无密钥。
- 成本与访问：两桌完整聚会测量，加机器人密集/长历史压力场景；大陆至少两种实际网络及微信验收，另测海外访问。

## 11. 回滚策略

- 切流前旧生产继续运行，预演不写真实牌局；DNS 托管迁移和应用迁移分开验收。
- 新站未开放写入时，可以恢复旧站路由；保留原 DNS 值、部署版本与私密数据备份。
- 新站已有写入后，优先回滚 Worker 代码到兼容版本，**继续使用同一个 Neon 数据库**。不能直接把 DNS 指回已经落后的 CloudBase 数据库。
- 必须回 CloudBase 时，先冻结新写、导出最新 Neon 数据、恢复兼容数据到旧库并验证，再切回。提前演练，避免丢票、丢筹码或重复结算。
- DO schema 采用可兼容演进，首次生产版本保留 HTTP 降级开关；WebSocket 问题可以单独关闭，不等于数据库回滚。
- CloudBase/Pages 观察期后再停用，之后才删旧部署依赖和过渡 Secret；不要在切流当天把回滚条件一并删除。保留平台不代表仍有免费资格，旧平台费用另核。

## 12. 执行时需要的权限与配置

本轮不需要用户把密钥发到聊天。执行时优先沿用已连接账号，缺少的授权在对应平台完成：

| 项目                                    | 用途与存放                                                           |
| --------------------------------------- | -------------------------------------------------------------------- |
| GitHub 对两仓库的推送/Actions 配置权限  | 提交代码、设置每仓库 Secret/变量、分支保护；本机 gh 若使用需完成登录 |
| Cloudflare 目标账号与最小权限部署 token | Worker 部署放各仓库 Secret；DNS zone 修改权限仅首次域名迁移需要      |
| Cloudflare account ID                   | 普通部署变量，可提交非敏感资源配置                                   |
| Neon 两项目的 runtime `DATABASE_URL`    | 仅各自 Worker Secrets，不能用 `VITE_` 或写入前端                     |
| Neon migration 连接串                   | 各仓库受保护部署 Secret，仅 migration job 使用；不复用 runtime 角色  |
| 现有两应用的身份/会话密钥               | 从旧云端安全迁移到相应 Worker，保留各自独立值，不输出原文            |
| 腾讯云域名管理权限                      | 调整 NS、检查旧 DNSSEC/DS；不用提供腾讯云全账号永久密钥              |
| 公众号配置（如当前已启用）              | 核对授权域名、redirect URI、验证文件；未启用则继续 guest             |

在确认本计划后，执行仍按 A → H 逐阶段完成；遇到测试失败、实际免费套餐限制或大陆访问不达标，先解决对应问题，再进入下一阶段。
