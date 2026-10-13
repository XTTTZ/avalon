# GitHub Pages 发布

网页地址：[https://www.avalonxty.site/](https://www.avalonxty.site/)。仓库已绑定这个自定义域名，GitHub 已签发 HTTPS 证书。网页由 GitHub Pages 托管，游戏 API 和数据库继续使用 CloudBase 新加坡环境。公众号菜单也可以填写这个地址，目前仍是 guest 登录。

2026-09-19 已完成首次发布：[Actions 成功记录](https://github.com/XTTTZ/avalon/actions/runs/35376552492)。跨域、登录、建房、邀请加入、刷新恢复、五人开局和身份隐藏均已实测通过。下面的首次配置已完成，不必重复操作。

## 首次配置

1. 打开 [仓库 Pages 设置](https://github.com/XTTTZ/avalon/settings/pages)。在 **Build and deployment → Source** 选择 **GitHub Actions**。
2. 打开 [Actions Variables](https://github.com/XTTTZ/avalon/settings/variables/actions)，确认已有配置：

| Name        | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `API_URL`   | `https://avalon-d4gupz2rs904bec10-1327068090.ap-singapore.app.tcloudbase.com/api/avalon` |
| `AUTH_MODE` | `guest`                                                                                  |

3. 在 CloudBase 云函数 `avalon` 的环境变量 `ALLOWED_ORIGINS` 中追加 `https://www.avalonxty.site`。本次也保留旧 CloudBase origin，并允许 `https://xtttz.github.io`，以后取消自定义域名时可用。以英文逗号分隔，不要填写路径或尾斜杠，其他密钥保持原值。
4. 打开 [Pages 工作流](https://github.com/XTTTZ/avalon/actions/workflows/pages.yml)，选择 **Run workflow → main → Run workflow**。等 `verify`、`build`、`deploy` 都变绿，打开上面的网页地址。

Pages 发布不需要新增 GitHub Token 或 CloudBase Secret。工作流使用 GitHub 自动提供的短期发布权限，只上传 `dist/` 网页；部署时会检查 CloudBase 的认证边界和跨域设置。该检查失败会显示警告，但不会阻止静态网页发布，避免 CloudBase 临时停机或余额不足时连网页修复也无法上线。检查通过只代表 API 可以访问，数据库登录、建房仍需实际验收。

## 以后更新

提交并推送到 `main` 后自动测试、构建和发布：

```sh
git add .
git commit -m "描述本次修改"
git push origin main
```

只改网页时等 **Deploy GitHub Pages** 完成即可。改了 `server/`、`shared/` 游戏规则或云函数代码后，还要运行已有的 **Deploy CloudBase** 工作流；有 SQL 更新时按数据库升级说明先执行 SQL。

Pages 工作流根据 GitHub 提供的地址构建资源路径，自定义域名使用 `/`，默认 `xtttz.github.io` 地址使用 `/avalon/`。邀请链接和二维码保留当前路径，不需要 SPA 路由重写。CloudBase 和本地构建继续使用根路径。

guest 身份按网站来源保存。第一次从旧 CloudBase 网址切到 Pages 会成为新玩家：旧对局继续使用旧网址，新局统一用 Pages。之后始终使用同一个网址和浏览器，刷新、重开会恢复身份。

## 出错时

- **Get Pages site failed / Not Found**：检查第 1 步，确认仓库是 public、Pages 来源为 GitHub Actions。
- **Set the repository variable API_URL**：检查第 2 步，API 地址必须完整，不能填 `/api`。
- **Allowed origin is not configured / Authentication boundary failed**：检查第 3 步，以及 CloudBase 云函数配置是否保存成功。
- **AvailableStatus = InsufficientBalance**：CloudBase 已停用云函数实例。进入腾讯云控制台检查环境套餐、资源包、欠费和账户余额；恢复后重新运行 **Deploy CloudBase**，确认 API 检查通过。
- 网页能打开但提示 **服务暂时不可用**：检查云函数的 `PG_API_KEY` 是否有效。更新 GitHub 的部署 Secret 不会自动更新云函数环境变量，参考 [Key 轮换说明](your-deployment.md#api-key-轮换)。

当前已绑定 `www.avalonxty.site`，无需重复修改 DNS。以后改域名时，在 Pages 设置完成域名、DNS 和 HTTPS 配置，再把新 origin 追加到 CloudBase。取消自定义域名后，重新运行工作流发布到 [默认 Pages 地址](https://xtttz.github.io/avalon/)。

工作流依据 [GitHub Pages 官方发布说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
