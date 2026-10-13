# 微信公众号接入

本地和首次云端验收使用 guest，公众号没有准备好时不会阻碍开发。只有确认公众号具备网页授权权限后，才把生产 `AUTH_MODE` 切为 `wechat`。

## 1. 准备公众号

个人主体通常可注册订阅号，但具体网页授权、菜单和接口权限以微信公众平台当前显示为准。登录 [微信公众平台](https://mp.weixin.qq.com/) 后，在“设置与开发 → 接口权限”确认能够使用网页授权，再继续配置。

记录 AppID。AppSecret 属于长期密钥，只填 Cloudflare Worker Secret 或 GitHub Secret，不要发到聊天、写入 `.env.example`、提交 Git 或放进 `VITE_` 变量。

## 2. 配置网页授权域名

正式入口为：

```text
https://www.avalonxty.site/
```

在公众号后台的“公众号设置 → 功能设置”中填写网页授权域名：

```text
www.avalonxty.site
```

后台若要求下载验证文件，将原文件放到 `public/` 根目录，重新构建和部署后，先确认 `https://www.avalonxty.site/文件名.txt` 原样返回，再点微信后台确认。不要给验证文件加 SPA HTML 或重定向。

授权域名只写主机名，不含 `https://`、路径或尾斜杠。业务域名与 JS 接口安全域名只有在使用相应能力时再配置，本应用的基础登录不依赖 JS-SDK。

## 3. 设置 Worker 配置

Cloudflare Worker `avalon` 使用：

| 名称                                | 类型     | 值                            |
| ----------------------------------- | -------- | ----------------------------- |
| `WECHAT_APP_ID`                     | 普通变量 | 公众号 AppID                  |
| `WECHAT_APP_SECRET`                 | Secret   | 公众号 AppSecret              |
| `WECHAT_REDIRECT_URIS`              | 普通变量 | `https://www.avalonxty.site/` |
| `AUTH_MODE` / 前端 `VITE_AUTH_MODE` | 普通变量 | 验收完成后设为 `wechat`       |
| `ALLOW_GUEST`                       | 部署变量 | workflow 按 `AUTH_MODE` 生成  |

redirect URI 必须与浏览器实际入口精确一致，包含协议、路径和尾斜杠。邀请房间号在 OAuth state 中保存，授权返回后恢复。

服务端使用 `snsapi_base` 的 code 换 OpenID。AppSecret、微信 access token 和 OpenID 映射都不会发送给其他玩家；浏览器提交的 OpenID 不可信，也不会被接受。

## 4. 创建菜单

在“自定义菜单”创建“阿瓦隆”，动作选“跳转网页”，地址填写：

```text
https://www.avalonxty.site/
```

先保存并发布菜单，再在真机微信中重新进入公众号查看。菜单发布可能有客户端缓存，测试时可退出公众号会话后重进。

## 5. 切换与回滚

1. 在 `workers.dev` 或受控测试入口完成 guest 全流程。
2. 配好授权域名和 Worker Secret。
3. 用测试账号验证 OAuth，再构建 `VITE_AUTH_MODE=wechat` 的同一提交。
4. 更新公众号菜单。
5. 保留原 `IDENTITY_SECRET` 与 `SESSION_SECRET`。轮换它们会改变玩家身份或让现有会话失效。
6. OAuth 故障时先回滚 Worker/前端到同一已验证提交；不要删除数据库用户或重置身份密钥。

## 6. 真机验收

至少使用两个真实微信账号检查：

- 菜单进入、分享邀请和二维码加入；
- 同一账号关闭微信后重新进入仍识别为原玩家；
- 锁屏、切后台、切 Wi-Fi/移动网络后恢复当前局；
- OAuth code 不能重复使用，state/verifier 不匹配会被拒绝；
- 身份在松手、切后台和离开窗口后立即隐藏；
- 其他玩家无法看到身份、任务个人票和私人笔记；
- `www.avalonxty.site` 的证书、API 与 WebSocket 在微信内置浏览器正常。

Playwright 覆盖手机浏览器行为，但不能代替真实微信 OAuth 和 WebView 生命周期测试。
