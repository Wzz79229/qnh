# 团队数据服务（已部署，待管理员授权）

Cloudflare Worker 与同域 PWA 已完成首次部署：[鲜期 App](https://qnh-shelf-life-api.w792294944.workers.dev/)。首次部署源码为 `main:b5a6096ad1dbb36952551b6b5b8c71c4ffbda553`，版本为 `ddf79631-81df-4273-86cf-7a84cd66e897`。

**本次线上复验 `/api/session` 仍返回 `SETUP_REQUIRED`，私有授权和团队共享尚未验收。** 首次检查时运行时只有 `ASSETS` 和 `ALLOWED_ORIGIN`，`GITHUB_TOKEN`、`TEAM_PASSWORD`、`SESSION_SECRET` 均未配置。本次接口结果确认配置仍不符合后台要求，但未重新查看各 Secret 的具体配置，不能据此断言每个 Secret 都缺失。聊天中的 GitHub 连接只供聊天工具使用，不能导出给公开 App 复用。

业务记录始终保存到私有仓库 `Wzz79229/bzq` 的 `main:data/shelf-life.json`，照片保存为 `photos/<小写 UUID>.jpg`。商品快照索引固定为 `main:data/catalog.json`，不可变商品分页固定为 `data/catalog/<generation>/<index>.json`。后端拒绝客户端指定其他仓库、分支、路径或转发网址。现有前端源代码仍可以保存在 GitHub。

## 管理员的一次配置

Cloudflare 账号和首次部署已就绪。管理员仍需在 Worker → Settings → Variables & Secrets 中以运行时 Secret 安全设置下列三个敏感值；Build Variables 不能替代运行时 Secret。不要把值发进聊天、提交 Git、填入前端 connection.json 或写入 wrangler.toml。

| Secret / 配置 | 要求 |
| --- | --- |
| `GITHUB_TOKEN` | 仓库所有者创建的专用 fine-grained PAT，仅授权 `Wzz79229/bzq`，Contents → Read and write。到期或撤销后需由管理员更新。 |
| `TEAM_PASSWORD` | 团队访问密码，至少 12 个字符，避免重复使用其他账号密码。 |
| `SESSION_SECRET` | 至少 32 个字符的独立高强度随机服务端密钥；不能与团队密码相同。轮换会使已有会话失效。 |
| `ALLOWED_ORIGIN` | 非敏感配置，必须为 `https://wzz79229.github.io`，已在 wrangler.toml 中声明。 |

按代码，任一配置缺失或不合要求，合法来源的 API 请求应返回 `503 SETUP_REQUIRED`，不会访问业务数据；配置变更后的线上接口仍待复验。这里没有自动生成或保存任何密码、令牌或会话密钥。

## 当前 Git Build 配置

| 项目 | 值 |
| --- | --- |
| GitHub 仓库 / 生产分支 | `Wzz79229/qnh` / `main` |
| Worker 名称 | `qnh-shelf-life-api`，与 wrangler.toml 一致 |
| Root directory | `apps/qnh-shelf-life/backend` |
| Build command | 下方 Node 命令，仅修改本次 Cloudflare 构建产物 |
| Deploy command | `npx wrangler deploy` |
| 静态资产 | wrangler.toml 的 `../dist`，绑定名 `ASSETS` |

```sh
node -e "require('node:fs').writeFileSync('../dist/connection.json',JSON.stringify({apiBase:'/'}))"
```

此命令将 Cloudflare 站点的 API 指向同域 `/api`，不会提交回 GitHub，也不会改动 `qnh/docs/shelf-life/` 的 Pages 发布文件或源码中的空配置。Wrangler 将导入的兄弟目录 `dist/core.mjs` 与 `dist/github.mjs` 一并打包。公开源码不包含 Secret，也不写入 Cloudflare `account_id`。

wrangler.toml 已设置 `preview_urls = false`，用于在部署该配置后关闭版本预览 URL。正式 `workers.dev` 入口继续启用；Git Build 会在 main 更新后发布新版本。

管理员完成授权后，先检查 `/api/session`，再验收一次团队登录、照片上传、记录保存和另一台手机读取；同时确认未登录请求不能读取记录或照片。当前首次部署尚不代表这些验收已通过。

## 使用与手机兼容性

用户首次输入团队密码，服务端设置最长 30 天的 HMAC 签名会话 Cookie。GitHub 令牌永远不进入浏览器。Cookie 使用 `HttpOnly; Secure; SameSite=None; Partitioned`；会话到期、清除浏览器数据、更换设备或轮换会话密钥后，需要重新登录。团队密码用于共同访问，没有独立成员身份或逐人撤销；移除成员时应同时更换团队密码和会话密钥。

PWA 和 API 已部署在同一个 Worker 域名。wrangler.toml 提供 `ASSETS` 绑定，同域请求受 HTTPS 来源检查保护。GitHub Pages 的连接配置仍为空；若将来启用 Pages 跨域连接，则必须 `fetch(..., { credentials: 'include' })`，并且仅允许上述精确 Origin 跨域访问。Safari 及其他禁止第三方 Cookie 的浏览器可能无法保持跨站登录；`Partitioned` 不是所有浏览器都支持，不能承诺每台手机都能跨域记住登录。应继续优先使用同域入口，不能把 GitHub 令牌放进前端解决。

OCR 在手机浏览器中运行。首次使用仅加载设备所需的一种内嵌 WASM core、两个 gzip 语言文件和 worker 脚本，按当前文件大小合计约 7.8 MB（约 8 MB）；不会为一次识别加载所有 core 变体或独立 `.wasm` 文件。

服务端对写入检查 Origin，所有业务读取也需要有效会话；显式跨站且无可信 Origin 的请求被拒绝。API 与照片响应均为 `private, no-store`，前端 Service Worker 也应排除 API 和业务照片缓存。

## 接口

| 接口 | 内容 |
| --- | --- |
| `GET /api/session` | `{configured:true,authorized:boolean}`，不含秘密或业务数据。 |
| `POST /api/login` | JSON `{password}`；成功后设置会话 Cookie。 |
| `POST /api/logout` | 清除当前浏览器的 Cookie。 |
| `GET /api/state` | 已登录才返回 `{data,sha}`；数据文件不存在时为 `{data:null,sha:null}`。 |
| `GET /api/catalog` | 已登录才返回固定商品索引 `{schemaVersion:1,source,generation,pages,total}`。 |
| `GET /api/catalog/pages/<index>` | 已登录才返回平铺 `{schemaVersion:1,source,products,generation,index}`，不接受 query 或客户端路径。 |
| `PUT /api/state` | JSON `{data,expectedSha}`；校验数据和版本，返回新 `{data,sha}`。 |
| `POST /api/photos` | JSON `{id,imageDataUrl}`，小写 UUID、JPEG data URL，图片最多 400,000 字节。返回 `{id,path}`。 |
| `GET /api/photos/<uuid>` | 已登录才返回 JPEG 二进制。 |

错误为 `{code,message}`。过期会话返回 401；SHA 冲突返回 `409 CONFLICT`，不覆盖、不合并、不自动重试。GitHub 数据 JSON 最多 1,000,000 字节；单次状态保存最多新增 12 个照片引用，每个商品批次最多 3 张。

## 商品快照读取

这里读取的是管理员同步到私有 `bzq` 的牵牛花快照，不是对牵牛花实时接口的代理。索引含 `source.platform: 'meituan-qnh'`、`source.syncedAt`、`source.scope` 和明确的 `source.complete`。清单或图片未核对齐全时应保留 `complete:false`，不能因文件已上传而改成完整。`imageUrl` 为空与实际图片读取失败均由前端显示占位，不以别的商品图补齐。

索引上限 128 KiB、最多 100 页与 50000 个 SKU；每页最多 500 个 SKU、900000 字节，前端整份规范化快照上限 8 MiB。每次读取分页都重新读取当前索引，仅允许索引指定的同代路径，并核对 Git Blob SHA、来源和条数。代次或文件不一致返回 `409 CATALOG_CHANGED`；索引不存在返回 `404 CATALOG_NOT_READY`，不会返回虚构空库。前端须比较 `generation`，不能拼接不同代次的商品。

商品字段只保留 `sku/spu/name/spec/barcodes/category/imageUrl`，编号与条码必须是字符串。官方图片源仅允许无凭据、无查询参数和片段的 HTTPS `img.meituan.net` 地址；服务器不接受任意图片代理网址。商品索引、分页、包装照片及其 API 响应都需要会话并使用 `private, no-store`；前端只在内存保存商品库，不能放入 Service Worker 业务缓存。

前端先上传该次新增的全部照片，再提交含 `photoRefs:[{id,path}]` 的状态。积累超过 12 个新引用时，前端按完整商品记录分批提交，每批成功立即保留新 SHA；后续失败仍保留完整草稿。上传相同 UUID 和相同照片可以安全重试；同 UUID 的不同照片不能覆盖已有照片。状态保存会确认新增引用的照片已存在。照片与数据文件属于分开的 GitHub 提交，不是事务：状态提交失败可能留下无引用照片，现有记录不会因此被覆盖。后端不自动删除照片；管理员手工删除文件可能造成断开的引用，应先备份。

登录失败在同一个 Worker isolate 内按 IP 尝试节流（15 分钟内 5 次），属于尽力而为。多实例、重启和多 IP 都可能绕过；上线团队使用前应配置 Cloudflare 的平台级限流或身份保护，不能将此内存计数当成全局防暴力破解保证。日志不得记录请求体、Cookie、GitHub 授权头或 Secret。

## 验证

在项目根目录运行 `npm test`，涵盖后台会话、照片、商品索引和分页 SHA/来源/代次校验、检索与明确选择规则。测试使用注入的 fetch、时钟与 WebCrypto，不访问真实 GitHub，也不部署云服务。实际部署后的 Cookie、手机浏览器跨域行为、GitHub 权限与商品/图片覆盖范围需单独验收，合成视觉测试不能替代这些确认。
