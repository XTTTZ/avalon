# CloudBase 部署检查

本项目使用**文档数据库或 PostgreSQL + Node.js 云函数 + 静态网站托管/自有 HTTPS 静态域名**。浏览器仅请求 HTTP API，不安装 CloudBase 浏览器 SDK、不直接查询数据库。具体套餐和免费额度以你的环境控制台为准。

首次操作请从 [逐步上线与 CI/CD 指南](../docs/deploy-step-by-step.md) 开始；本文用于核对数据库、环境变量与运维细节。

## 数据库

### PostgreSQL 环境（你的新加坡环境）

用管理员 SQL 编辑器执行 [postgres.sql](postgres.sql)，可重复执行，不清空已有数据。设置云函数 `STORE_BACKEND=postgres`、`PG_REST_URL=https://环境ID.api.tcloudbasegateway.com/v1/rdb/rest`、`PG_API_KEY=服务端环境APIKey`。API Key 仅保存在云函数环境变量，不能放入 `VITE_` 配置或前端。

`avalon_documents` 保存四类记录的 JSON、到期时间和 UUID 修订号。表启用 RLS，撤销 PUBLIC/anon/authenticated 的表与 RPC 权限，仅 service_role 可访问。`avalon_commit` 在单个 SQL 事务中锁定全部读写键（包括尚不存在的键）、检查修订号、统一写入；冲突会重新执行业务事务。UUID 修订号防止删除重建后误接受旧写入。清理沿用每小时触发器。

初始化只在首次部署执行；日常 CI 只更新代码，不执行迁移，也不修改会话密钥。新增 SQL 结构时先在独立测试环境验证再手动迁移。参考 [CloudBase PostgreSQL 说明](https://docs.cloudbase.net/database/postgresql/initialization)。

### 文档数据库环境

在同一环境创建 `avalon_rooms`、`avalon_users`、`avalon_notes`、`avalon_oauth` 四个文档集合；每个集合建立 `expiresAt` 数值字段的升序单字段索引。`collections.json` 是人工部署清单，不是 CloudBase CLI 导入格式。

对**每个集合**应用 `database.rules.json`：`{"read":false,"write":false}`。这些规则禁止客户端 SDK 访问，服务端云函数通过环境身份访问。不要给浏览器或匿名用户提供数据库访问权限，也不要把管理密钥打进前端。

| 集合           | 服务端内容                                  | 到期时间                   |
| -------------- | ------------------------------------------- | -------------------------- |
| `avalon_rooms` | 权威房间状态、身份、秘密票、命令去重记录    | 建房/重新开局后 7 天       |
| `avalon_users` | 随机化玩家标识、上次房间、建房/加入去重记录 | 365 天；登录接近到期时续期 |
| `avalon_notes` | 房间 + 可信会话玩家自己的昵称、猜测和笔记   | 对应房间到期               |
| `avalon_oauth` | 一次性授权 state 与浏览器 verifier 的哈希   | 10 分钟                    |

`expiresAt` 存毫秒时间戳，**不是原生 TTL Date 字段**，需启用下述清理触发器。所有业务读取仍校验逻辑过期时间，过期数据尚未物理删除也不可加入或读取。

## 云函数和环境变量

运行根目录 `npm run build:cloud` 生成 `cloudfunctions/avalon/index.js`，按根目录 README 部署该目录并安装其生产依赖。Node.js 运行时至少 18，建议可用的 20/22；入口 `index.main`，建议超时 20 秒、内存 256 MB 起步。不要上传 `.env.local`、`.data/` 或开发账号凭据。

先运行 `npm ci --prefix cloudfunctions/avalon --omit=dev`，上传安装好的 `node_modules`，关闭云端安装依赖。CLI 配置及发布工作流已这样设置。

| 环境变量                              | 配置                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `SESSION_SECRET`                      | 必填，至少 32 字节随机秘密；只放云函数环境变量                                    |
| `IDENTITY_SECRET`                     | 建议独立的至少 32 字节随机秘密；缺省使用 SESSION_SECRET                           |
| `ALLOW_GUEST`                         | 使用 guest 登录设 `true`；只允许微信授权时设 `false`                              |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 具备网页授权权限的公众号凭据，AppSecret 仅服务端                                  |
| `WECHAT_REDIRECT_URIS`                | 逗号分隔的精确 HTTPS 回调 URL，如 `https://play.example.com/`；不含 query/hash    |
| `ALLOWED_ORIGINS`                     | 逗号分隔的精确 HTTPS 前端 origin，如 `https://play.example.com`；不带路径或尾斜杠 |
| `CLOUDBASE_ENV_ID`                    | 可选；未设置时使用当前云函数环境                                                  |

会话有效期 180 天，每次重新进入网页会续期；OpenID 不发送给浏览器，不保存平台 access_token。`IDENTITY_SECRET` 决定 OpenID/device 对应的玩家身份，必须长期保留；更换它会造成身份变化、无法恢复原座位。更换 `SESSION_SECRET` 会使现有会话失效，但保持 IDENTITY_SECRET 不变时可重新授权恢复同一玩家。

为云函数创建 HTTP 网关访问服务，路径设为 `/api/avalon`，放行 POST/OPTIONS；根目录前端构建时 `VITE_API_URL` 指向完整 HTTPS 地址，例如 `https://api.example.com/api/avalon`。本项目的 `cloudbaserc.json` 使用普通 Event 云函数入口 `index.main`，因此部署后在控制台为 `avalon` 函数新增 HTTP 网关路由，不要改成需要监听 9000 端口的容器服务。云函数已校验 Origin 并返回精确 CORS 响应。公开的是经过认证校验的 HTTP 接口，绝不是公开数据库。云函数直接 SDK 调用无需授予客户端权限。

## 定期清理和用量控制

为该函数添加定时触发器，名称必须为 **`avalon-cleanup`**，建议每小时触发一次（按控制台所示时区设置）。平台事件 `Type=Timer`、`TriggerName=avalon-cleanup` 触发清理；HTTP 请求体中的同名字段不会被视为平台触发器。每次最多删除 400 条过期记录，对每条在事务中再次确认过期，避免误删刚续期的用户。

常规 `get` 轮询只读取一条房间文档、零写入；版本未变返回很小的响应。前端后台/离线暂停，前台按阶段在 4–20 秒基础上退避。10 人同时在线且每 10 秒轮询约 3,600 次房间读取/小时；实际任务阶段可能更频繁，另有命令事务和登录读写。组局时长和频率会影响免费额度，不能承诺长期免费。

服务器对每位玩家限制每分钟 60 次房间写入、每小时 5 次建房，并有每个温实例的请求频率限制。温实例内存限流不能代替全局网关防刷：在控制台配置可用的请求限流、费用/额度告警，查看匿名授权接口异常流量。不要开启请求体/响应体日志记录；这些内容可能包含会话、身份、任务票或笔记。

## 微信公众号与验收

公众号后台配置业务/网页授权域名及要求的校验文件，将菜单 URL 指向前端页面。HTTPS 页面和 API 域名均需能在真实微信网络下访问。首次打开走 `snsapi_base` 静默授权；服务器白名单 URL 必须与前端 `location.origin + location.pathname` 完全一致。邀请码放在 `?room=123456` 中，授权流程会保存并恢复它。

先运行本地自动测试，再用独立测试环境验证：云数据库事务、首次 OAuth、关闭微信后恢复、两手机同时投票、Wi-Fi/蜂窝切换、后台自动遮盖身份、同房主无法读取其他人笔记、未登录调用 get 拒绝。`npm run smoke:cloud` 可检查已部署 HTTP 端点的匿名拒绝与 CORS；它不能替代数据库事务和真实微信真机验收。

实现对照：[CloudBase Node SDK 数据库文档](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)、[CloudBase 服务端事务](https://docs.cloudbase.net/database/transaction)。实际权限、运行时选项和套餐额度请以控制台当时的配置为准。
