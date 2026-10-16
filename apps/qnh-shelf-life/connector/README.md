# 牵牛花管理员浏览器连接测试

此目录是独立的 Cloudflare Worker 源码，尚未部署或进行云端 API 兼容性验证。它不更改现有保质期管理后台，不进行商品同步，不保存牵牛花密码、Cookie、storageState 或 Live View JWT。

## 配置边界

部署前必须为本 Worker 启用 Cloudflare Access，策略仅允许本 Cloudflare 账号的管理员成员，覆盖所有生产域名和预览地址。Worker 每次要求原生 `ctx.access`，未获得验证身份返回 403；伪造请求头不起作用。它不使用成员共用团队口令。Zero Trust 需要事先开通；没有 Access 的部署始终无法操作。

代码仅使用官方原生 Browser binding，无 npm 运行依赖，无需 Cloudflare API token。配置包括 `BROWSER` 和 SQLite Durable Object `CONNECTOR_SESSIONS`。使用仓库已有经验证的 Wrangler 工具发布即可；不要另行下载未核验工具。

默认仅允许已确认的 `qnh.meituan.com` 和 `img.meituan.net`。登录跳转、验证码或静态资源如果需要其他主机，必须先从实际页面确认，再在私有部署设置 `QNH_ALLOWED_HOSTS`（逗号分隔的精确美团域名，不接受通配符或 URL）。现有两个主机不代表完整登录依赖。不要用放开所有域名来掩盖访问失败。

## 行为

- 管理员点击“开始”才创建浏览器；没有自动启动、后台轮询或定时同步。
- 每 UTC 日仅一次尝试（北京时间每天 08:00 重置），所有管理员共享该预算。失败也消耗本日尝试。
- 固定商品主档 URL，不接收外部 URL、JavaScript、会话 ID 或用户提供的仓库参数。
- SQLite DO 保存身份哈希、会话和目标 ID、截止时间以及当日已尝试标记。操作串行；同一会话只可由创建者操作。
- 5 分钟绝对截止 alarm 主动关闭浏览器，60 秒闲置超时作为后备。Alarm 可能延迟，无法承诺精确到毫秒的关闭。停止失败保留待关闭状态并每 15 秒重试，不会假报已关闭。
- Live View 只从单独的、已认证同源 POST 返回，默认一分钟链接有效期。只提供 `tab` 模式，响应禁止缓存、禁止 Referrer，不记录任何上游错误或凭据。
- 管理员在 Live View 亲自登录，系统不获取密码或 Cookie。检查只读可见 DOM；商品主档路径、主档文字、商品表头、至少一行 SPU 同时成立才标记 `catalog_ready`。仅隐藏登录框或到达 URL 均为 `login_unverified`。
- 测试结束后没有持久登录能力；`catalog_ready` 不表示商品库或图片同步完成。

接口均不接受请求体；API 必须带 `X-Qnh-Connector: 1` 和浏览器同源 fetch metadata，POST 要求准确 Origin。外部跨域调用、直接导航 API、缺失身份/绑定均拒绝。

## 尚待真实验证

原生 Browser binding 方法和参数按 2026-10-16 官方文档实现，未调用用户账号的 Browser Run。需要验证实际账号运行时是否暴露这些最新方法、牵牛花是否接受 Cloudflare 出口、登录依赖主机及商品表头真实结构。任何不符均保持未验证状态；当前不支持静默退回 Cookie 抓取或密码自动填入。

官方依据：

- [Browser binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)
- [Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/)
- [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## 本地验证

`node --test tests/connector.test.mjs`（在项目根目录）。测试完全 mock，不启动浏览器、不使用真实身份或商品数据、不消耗云端额度。
