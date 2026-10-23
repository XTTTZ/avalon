# 阿瓦隆手机版 Web App 实施计划

> **现行架构（2026-10-14）：** React + TypeScript 前端与 API 统一部署到 Cloudflare Worker；静态资源使用 Workers Static Assets，权威状态保存到 Neon PostgreSQL，Durable Object 只负责房间 WebSocket 版本通知。生产使用 guest 身份，从空数据库开始，不迁移旧数据。
>
> 德州扑克已经拆到同级独立仓库 [`XTTTZ/avalon-poker`](https://github.com/XTTTZ/avalon-poker)。部署资源和上线步骤见 [Cloudflare + Neon 操作单](docs/cloudflare-neon-migration-runbook.md)。

## 目标与交付

实现供朋友线下面对面使用的手机 Web App。用户打开 HTTPS 网页即可建房或加入；无需安装客户端或维护自建服务器。生产目标为 `https://www.avalonxty.site`，DNS 切换前可直接使用 `https://avalon.avalon-roundtable.workers.dev` 验收。

## 已完成

- [x] 建立共享类型、标准规则表、运行脚手架与环境配置。
- [x] 实现服务端状态机：大厅、发身份、确认身份、组队、投票、任务、湖中仙女、刺杀、结算。
- [x] 实现仅本人秘密投影、匿名任务票、私人笔记、版本控制、幂等命令与事务存储。
- [x] 实现手机优先界面：建房/加入/二维码、规则、玩家列表、隐私身份卡、行动面板、记录与笔记。
- [x] 实现刷新/重开恢复、前后台切换、网络恢复、WebSocket 通知与低频 polling 兜底。
- [x] 完成 Avalon 与 Poker 拆仓，各自使用独立 Worker、Neon 项目和 GitHub Actions。
- [x] 完成 Cloudflare Worker、Static Assets、Durable Object 和 Neon PostgreSQL 适配。
- [x] 建立单元测试、PostgreSQL 17 schema/权限测试、手机浏览器 E2E、构建和 Worker dry-run 门禁。

## 生产上线待办

- [x] 配置 GitHub Actions 的 Cloudflare、Neon 和应用密钥。
- [x] 在 `CUSTOM_DOMAIN_ENABLED=false` 下从 Actions 发布并验收 workers.dev。
- [x] 将域名 nameserver 切换到 Cloudflare，等待 zone active。
- [x] 设置 `CUSTOM_DOMAIN_ENABLED=true`，绑定并验收 `www.avalonxty.site`。
- [ ] 记录实际 Worker、Durable Object 与 Neon 免费额度消耗。

## Poker 平台功能同步（2026-10-23）

- [x] 迁移浅色、深色和跟随系统主题；保留手机大字、隐藏身份时的固定布局。
- [x] 增加 PWA 图标、安装入口、独立窗口与安全区域适配；离线仅显示提示，不缓存身份、房间或 API 响应。
- [x] Neon 按数据库 UUID revision 校验后复用有界服务端快照；私人笔记独立读取，事务和权限判断不使用过期状态。
- [x] WebSocket 增加连接超时、心跳、退避重连及前后台/网络切换恢复；合并读取中的通知，不自动重投票。
- [x] 增加缓存一致性、断线恢复、主题和 PWA 回归测试，接入现有 Actions 门禁。
- [x] 完成构建、数据库和手机验收，并同步部署与使用文档。

本次只迁移通用能力；不引入 Poker 的俱乐部、账户恢复或牌局规则。游戏权威状态仍保存在 Neon，WebSocket 继续只通知版本，客户端按本人权限读取数据。

验收记录：146 项单元/Worker 测试、21 项手机浏览器测试，以及真实 PostgreSQL 17 schema、清理、权限和缓存测试通过。[Actions 发布](https://github.com/XTTTZ/avalon/actions/runs/39959969660)已将 `aa2b92b` 上线至正式域名。线上验证了主题持久化、PWA 注册与资源、guest 登录、条件读取、版本通知、心跳和同页连接替换；临时验收房间已解散。实际 Neon 出站节省仍需按真实游戏量观察。

## 确定的规则边界

- 标准 5–10 人：阵营人数分别为 3/2、4/2、4/3、5/3、6/3、6/4；使用官方五轮任务表，连续五次拒绝组队邪恶胜；7 人及以上第四轮两张失败票才失败。
- 11–12 人明确标记为自定义扩展。自定义允许修改阵营、角色、3–9 轮任务、人数、失败阈值、获胜任务数和连续拒绝上限。
- 湖中仙女在第 2、3、4 次任务结束且游戏未结束时行动；持有人查看一名从未持有湖中仙女的玩家当前阵营，再把标记交给对方。
- 兰斯洛特使用明确标注的本应用扩展：成对加入、初始一善一恶，可选从第三轮开始在任务轮开始时公开抽取阵营变化牌。
- 身份发放后至结算前，刺客可随时刺杀；入口仅在刺客本人主动显示身份后出现，选人窗口不受身份五秒显示计时限制。
- 局中房主必须显式结束本局才能踢人；结算后玩家可立即离开，房主可解散房间。

## 架构与安全

- `shared/`：前后端契约、角色文案和公开规则配置。
- `server/`：游戏状态机、严格命令校验、按玩家投影、guest 身份与 HTTP API。
- `worker/`：Cloudflare Worker、Static Assets 路由、定时清理和房间 Durable Object。
- `src/`：React 手机界面；浏览器仅保存会话、房间位置和本人 UI 草稿。
- `migrations/`：Neon schema、原子提交函数、清理函数与最小权限授权。
- 房间秘密仅存在服务端；响应使用显式字段白名单，不依赖 CSS 隐藏权限。
- 私人笔记按可信会话所有者隔离，房主没有读取他人笔记的接口。
- Neon 写入由单个数据库函数原子提交；客户端携带版本与幂等 requestId，重试不会重复推进。
- WebSocket 只通知 `{roomInstanceId, gameId, version}`，收到通知后再通过 HTTP 获取本人的最新投影。

## 手机体验完成记录

- 提示和功能说明已经精简，公共正文和主要按钮适配手机字号与至少 44px 触摸区域。
- 玩家头像、身份卡、笔记卡和圆桌布局在 320px–390px 宽度保持对齐，不产生横向溢出。
- 房主可以进入排序状态拖动玩家卡；开局时玩家顺序和角色分别使用安全随机洗牌。
- 玩家公开名在服务端保证房内唯一；私人昵称在本人视图的玩家卡、操作窗口和战报统一替换。
- 数字规则使用触屏步进器，也允许清空后直接输入；默认角色随人数增加特殊角色。
- 刷新按钮只更新游戏状态，不整页刷新；切后台、断网和重新打开后可恢复同一玩家。
- 湖中仙女持有人历史公开显示，查验到的阵营仍只对查验人可见。
- 任务票保持匿名，只公布汇总；组队票在全部提交后统一公开。

## 验收标准

- 5–12 人规则、善恶获胜、提前刺杀、湖中仙女、兰斯洛特和自定义配置均由状态机测试覆盖。
- 非成员、非房主、非队长、重复请求和跨阶段请求均被服务端拒绝或幂等处理。
- Worker 不向浏览器返回整桌身份、私人笔记所有者之外的数据或个人任务票。
- 两台以上移动浏览器可以完成建房、加入、发身份、投票、任务、结算和断线恢复。
- GitHub Actions 必须通过格式、类型、单元测试、PostgreSQL 权限测试、生产构建、手机 E2E 和 Worker dry-run 后才部署。
- DNS 切换前 workers.dev 首页与 `/api/health` 正常；启用正式域名后两套地址同时通过健康检查。
