# 管理员一次 GitHub App 授权

目标仅为后台读写私有 `Wzz79229/bzq`；不要求员工拥有 GitHub 账号或创建个人令牌。手机牵牛花身份接入仍是独立的未完成步骤。

## 1. 注册私有 App

使用 Wzz79229 的 GitHub 账号打开下面的预填页面：

[打开 GitHub App 注册页](https://github.com/settings/apps/new?name=qnh-bzq-Wzz79229&description=QNH%20shelf-life%20private%20batch%20storage&url=https%3A%2F%2Fqnh-shelf-life-api.w792294944.workers.dev%2F&public=false&webhook_active=false&contents=write&metadata=read)

核对：名称 `qnh-bzq-Wzz79229`；主页为现有 App；Webhook 关闭；Repository permissions 的 **Contents: Read and write** 和 **Metadata: Read-only**；其他权限不授予；安装范围选择 **Only on this account**。名称已被占用时，使用一个可辨认的新名称。

管理员亲自点击 Create GitHub App。注册后记录数字 **App ID**，不是 Client ID。在 Credentials → Key pairs 中亲自点击 New key（旧版为 Generate a private key），按提示下载 PEM 文件；该文件是凭据，不发聊天，不提交仓库，也不要由助手读取。

## 2. 只安装到 bzq

App 设置中选择 Install App → Wzz79229 → **Only select repositories** → 仅勾选 **bzq**，核对 Contents 读写和 Metadata 只读后，管理员亲自点击 Install。

安装配置页面 URL 形如 `https://github.com/settings/installations/12345678`，末尾数字就是安装 ID。此编号不是秘密，可以记录；不要把临时 token 或 PEM 放进网址。

## 3. Cloudflare 运行时配置

打开现有 `qnh-shelf-life-api` → Settings → Variables and Secrets，设置：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `GITHUB_APP_ID` | Text | App 设置里的数字 App ID |
| `GITHUB_APP_INSTALLATION_ID` | Text | 上一步安装配置 URL 的数字 ID |
| `GITHUB_APP_PRIVATE_KEY` | Secret | 本人打开下载的 PEM，将包含 BEGIN/END 的完整多行内容粘贴到 Cloudflare |

Cloudflare 新版添加变量表单中，私钥所在行必须勾选 **Secret**。若单行 Value 输入框在粘贴时移除了换行，后台会规范化 PEM 格式；BEGIN/END 标签和中间的全部内容仍须完整。不要使用浏览器自动填充的密码代替私钥。

Wrangler 已启用 `keep_vars = true`，后续从 GitHub 自动部署时保留管理员在面板配置的 App ID 和安装 ID。私钥始终使用 Secret，不写入仓库。

由管理员完成 Secret 保存和 Deploy。不要把私钥发到聊天或填进 Build Variables。App 模式不需要 `GITHUB_TOKEN`；即使旧变量仍在，只要任一 App 字段存在，后台就要求三项 App 配置完整，不静默回退旧令牌。

本机桥接另外使用 `QNH_CONNECTOR_KEY`；现有无需密钥的“连接牵牛花”试查入口不受云端配置影响。

## 验收范围

后台使用 RS256 签名获取仅 `bzq` 的 Contents 读写访问凭据，并在过期前自动刷新。JWT、PEM、访问凭据仅在后台内存中，不写 GitHub、日志、前端或浏览器缓存。GitHub 拒绝凭据时清除内存缓存，下次重新验证；不会自动重试不确定的业务写入。

生产使用 `MEMBER_AUTH_MODE=qnh`。`/api/session` 会实际验证 GitHub App 安装和仅限 `bzq` 的受限令牌签发；成功增加 `githubAuthorization:ready`，失败返回 503 和 `githubAuthorization:unavailable`。检查不读取业务文件，不向前端返回令牌、签名或私钥；按完整配置隔离缓存与并发请求，成功及失败各缓存 30 秒，避免刷新反复触发外部授权。

当前未取得可验证的牵牛花员工登录接口，所以即使 GitHub 授权通过，仍返回 `loginMethod:qnh_pending`、`authorized:false`；不会允许团队口令、电脑登录或旧团队 Cookie 代替员工身份。授权就绪检查不等于业务文件读取或批次保存实测。只有接入身份、再完成手机扫码查询与批次保存实测，才能算整体接通。

官方依据：[预填注册参数](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters)、[安装访问凭据](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)。
