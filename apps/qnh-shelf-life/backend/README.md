# 鲜期后台与牵牛花内置登录

管理员 GitHub App 授权继续使用既有配置，仅读写私有 Wzz79229/bzq。员工不需要 GitHub 账号、个人令牌或额外团队口令。授权说明见 [GITHUB_APP_SETUP.md](GITHUB_APP_SETUP.md)。

当前手机登录、会话隔离、租户范围、额度与真实验收要求，以 [PHONE_LOGIN.md](PHONE_LOGIN.md) 为准。

## 当前流程

鲜期内显示官方牵牛花云端页面，员工本人完成登录。服务端确认新的商品访问结果并绑定实际登录租户后，读取该租户批次；数据读取成功才进入管理页。打开页面、返回鲜期或客户端标记均不能授予权限。旧 Pages 入口切至同一个鲜期主域。

QNH_TENANT_MODE=per_tenant，不预设租户，也不接受客户端选择租户。批次固定到 bzq/main:data/tenants/<可信租户编号>/shelf-life.json，隔离读写。历史 data/shelf-life.json 不自动读取或迁移；新手机流程不提供旧商品库和照片接口。

## 部署

- Worker: qnh-shelf-life-api，主入口 https://qnh-shelf-life-api.w792294944.workers.dev/
- Git Build 根目录: apps/qnh-shelf-life/backend；部署命令: npx wrangler deploy。
- 构建命令将部署产物 ../dist/connection.json 的 apiBase 改为 /。
- Wrangler 保留 keep_vars=true，并声明 BROWSER、QNH_PHONE_SESSIONS、QNH_BROWSER_BUDGET。
- 原运行时变量 GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID 和 Secret GITHUB_APP_PRIVATE_KEY 继续保留。无需重新创建凭据。
- 每 UTC 日两次、合计八分钟的保守登录试用预算；未启用付费套餐，不承诺日常多人容量。

## GitHub 授权边界

RS256 JWT 和受限安装令牌只保留在服务端。每次刷新核对固定 bzq 安装、权限、账号及未暂停状态，令牌只请求 bzq Contents 写权限。部分 App 配置不会退回 PAT，错误不反射凭据、上游正文或请求头。

服务端 fetch 使用 Workers 支持的 redirect:manual，并拒绝 3xx、已跳转或异域响应；不会把调用者 Cookie 转发给 GitHub。共享浏览器 GitHubStore 保留原有浏览器策略。

## 历史兼容

明确 legacy 模式保留旧 PAT/团队会话，仅供历史部署兼容。生产 qnh 模式不接受旧团队 Cookie 或团队口令。电脑桥接模块保留独立验证用途，不能授权手机会话；新手机即时 SKU 查询不使用共享 GitHub 任务队列。

本地 mock 测试不能替代真实登录、SKU 查询、保存和第二租户隔离验收。未通过实际验证不得宣称完整流程已经可用。
