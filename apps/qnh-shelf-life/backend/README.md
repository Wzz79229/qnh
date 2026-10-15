# 团队数据服务（尚未部署）

此目录准备了 Cloudflare Worker 后端，尚未创建云服务、部署或配置任何凭据。聊天中的 GitHub 连接只供聊天工具使用，不能导出给公开 App 复用。

业务记录始终保存到私有仓库 `Wzz79229/bzq` 的 `main:data/shelf-life.json`，照片保存为 `photos/<小写 UUID>.jpg`。后端拒绝客户端指定其他仓库、分支、路径或转发网址。现有前端源代码仍可以保存在 GitHub。

## 管理员的一次配置

需要管理员提供可部署的 Cloudflare 账号，并通过平台 Secret 配置界面安全设置下列值。不要把值发进聊天、提交 Git、填入前端 connection.json 或写入 wrangler.toml。

| Secret / 配置 | 要求 |
| --- | --- |
| `GITHUB_TOKEN` | 仓库所有者创建的专用 fine-grained PAT，仅授权 `Wzz79229/bzq`，Contents → Read and write。到期或撤销后需由管理员更新。 |
| `TEAM_PASSWORD` | 团队访问密码，至少 12 个字符，避免重复使用其他账号密码。 |
| `SESSION_SECRET` | 至少 32 个字符的独立高强度随机服务端密钥；不能与团队密码相同。轮换会使已有会话失效。 |
| `ALLOWED_ORIGIN` | 非敏感配置，必须为 `https://wzz79229.github.io`，已在 wrangler.toml 中声明。 |

任一配置缺失或不合要求，所有 API 返回 `503 SETUP_REQUIRED`，不会访问业务数据。这里没有自动生成或保存任何密码、令牌或会话密钥。

从 `backend/` 使用 Cloudflare 官方 Wrangler 工作流打包和部署 `wrangler.toml`；Wrangler 会将导入的兄弟目录模块一并打包。部署后先检查 `/api/session`，再由管理员将前端 `connection.json` 的 `apiBase` 指向实际 HTTPS 服务地址。本目录不包含自动部署脚本，也不会为你创建账号或开通付费资源。

## 使用与手机兼容性

用户首次输入团队密码，服务端设置最长 30 天的 HMAC 签名会话 Cookie。GitHub 令牌永远不进入浏览器。Cookie 使用 `HttpOnly; Secure; SameSite=None; Partitioned`；会话到期、清除浏览器数据、更换设备或轮换会话密钥后，需要重新登录。团队密码用于共同访问，没有独立成员身份或逐人撤销；移除成员时应同时更换团队密码和会话密钥。

推荐将 PWA 和 API 一起部署在同一个 Worker 域名。wrangler.toml 已提供 `ASSETS` 绑定，同域请求受 HTTPS 来源检查保护。若继续使用 GitHub Pages 前端，则必须 `fetch(..., { credentials: 'include' })`，并且仅允许上述精确 Origin 跨域访问。Safari 及其他禁止第三方 Cookie 的浏览器可能无法保持跨站登录；`Partitioned` 不是所有浏览器都支持，不能承诺每台手机都能跨域记住登录。遇到此问题应改为同域托管，不能把 GitHub 令牌放进前端解决。

服务端对写入检查 Origin，所有业务读取也需要有效会话；显式跨站且无可信 Origin 的请求被拒绝。API 与照片响应均为 `private, no-store`，前端 Service Worker 也应排除 API 和业务照片缓存。

## 接口

| 接口 | 内容 |
| --- | --- |
| `GET /api/session` | `{configured:true,authorized:boolean}`，不含秘密或业务数据。 |
| `POST /api/login` | JSON `{password}`；成功后设置会话 Cookie。 |
| `POST /api/logout` | 清除当前浏览器的 Cookie。 |
| `GET /api/state` | 已登录才返回 `{data,sha}`；数据文件不存在时为 `{data:null,sha:null}`。 |
| `PUT /api/state` | JSON `{data,expectedSha}`；校验数据和版本，返回新 `{data,sha}`。 |
| `POST /api/photos` | JSON `{id,imageDataUrl}`，小写 UUID、JPEG data URL，图片最多 400,000 字节。返回 `{id,path}`。 |
| `GET /api/photos/<uuid>` | 已登录才返回 JPEG 二进制。 |

错误为 `{code,message}`。过期会话返回 401；SHA 冲突返回 `409 CONFLICT`，不覆盖、不合并、不自动重试。GitHub 数据 JSON 最多 1,000,000 字节；单次状态保存最多新增 12 个照片引用，每个商品批次最多 3 张。

前端必须先上传该次新增的全部照片，再提交含 `photoRefs:[{id,path}]` 的状态。上传相同 UUID 和相同照片可以安全重试；同 UUID 的不同照片不能覆盖已有照片。状态保存会确认新增引用的照片已存在。照片与数据文件属于分开的 GitHub 提交，不是事务：状态提交失败可能留下无引用照片，现有记录不会因此被覆盖。后端不自动删除照片；管理员手工删除文件可能造成断开的引用，应先备份。

登录失败在同一个 Worker isolate 内按 IP 尝试节流（15 分钟内 5 次），属于尽力而为。多实例、重启和多 IP 都可能绕过；上线团队使用前应配置 Cloudflare 的平台级限流或身份保护，不能将此内存计数当成全局防暴力破解保证。日志不得记录请求体、Cookie、GitHub 授权头或 Secret。

## 验证

在项目根目录运行 `node --test tests/backend.test.mjs`。测试使用注入的 fetch、时钟与 WebCrypto，不访问真实 GitHub，也不部署云服务。实际部署后的 Cookie、手机浏览器跨域行为与 GitHub 权限需单独验收。
