# GitHub App 后台授权与牵牛花员工身份

后台已支持管理员一次安装 GitHub App，仅读写私有 Wzz79229/bzq。配置见 [GITHUB_APP_SETUP.md](GITHUB_APP_SETUP.md)。GitHub App 不等于员工身份认证；员工手机必须直接登录牵牛花这一要求尚未接通。

## 当前部署配置

- Worker: qnh-shelf-life-api，同域 PWA: https://qnh-shelf-life-api.w792294944.workers.dev/
- Git Build 根目录: apps/qnh-shelf-life/backend；部署命令: npx wrangler deploy。
- 构建命令仍将部署产物 ../dist/connection.json 的 apiBase 改为 /。
- ALLOWED_ORIGIN 固定 https://wzz79229.github.io；MEMBER_AUTH_MODE 固定 qnh。
- 运行时变量: GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID；运行时 Secret: GITHUB_APP_PRIVATE_KEY。
- 本机桥接另外需要 QNH_CONNECTOR_KEY；无需密钥的电脑试查入口不受影响。

App 模式不要求个人 GITHUB_TOKEN、员工 TEAM_PASSWORD 或旧团队会话密钥。旧 PAT/团队会话仅保留明确 legacy 模式兼容；生产 qnh 模式不接受旧团队 Cookie 或团队口令。

## 授权边界

JWT 使用 RS256，iat 回溯 60 秒，exp 为当前时间后 9 分钟。每次刷新先验证固定 bzq 的安装 ID、App ID、账号、Contents 写权限和未暂停状态，再请求 repositories:[bzq]、permissions:{contents:write}。响应必须只含 bzq，不能扩大权限。

PEM 支持 GitHub 常见 PKCS#1 与 PKCS#8 RSA 格式，最少 2048 位。访问凭据仅保留在 Worker 内存，过期前 90 秒刷新；并发请求共享一次获取，配置或密钥变化隔离缓存。身份请求超时和响应大小有限制，不跟随重定向，错误不反射上游正文或凭据。业务返回 401 时清缓存，下次重新获取；不自动重试不确定的业务写入。

服务端使用 Workers 支持的 `redirect:manual`，并拒绝所有 3xx、已跳转或异域响应。服务器没有浏览器 Cookie 存储，不转发调用者 Cookie，也不传入浏览器专用的 credentials/referrerPolicy 选项；共享的浏览器 GitHubStore 仍保留原策略，由服务端适配层转换。

## 员工手机登录尚未接通

生产 qnh + App 模式的 /api/session 会验证固定 GitHub App 安装和受限令牌签发，成功返回 githubAuthorization:ready，失败返回 503 / githubAuthorization:unavailable；成功及失败检查缓存 30 秒，并隔离配置变更和并发请求。该检查不访问业务文件，不返回授权凭据，也不是批次保存验收。即使 GitHub 授权通过，仍返回 configured:true、authorized:false、loginMethod:qnh_pending。/api/login 不接受团队口令，批次读取、写入和手机 SKU 任务保持禁止。App 明确显示尚未接通，不会把打开牵牛花网页或电脑登录视为员工已登录。

当前没有取得牵牛花官方员工身份授权接口、应用凭据及回调说明。需要官方可验证的员工和商户身份结果，才能实现每位员工手机登录后保存。商品 API 或门店整体授权不能直接充当员工身份认证。未实现电脑绑定手机方案。

## 数据与兼容接口

业务数据固定 main:data/shelf-life.json；按需商品任务固定 data/qnh-queries.json，使用预期 SHA 进行版本冲突保护。旧商品快照及照片接口保留历史兼容；新批次照片只用于手机本地 OCR，不上传。

本机桥接 POST /api/qnh/bridge/claim、/result 仍要求独立 Bearer key，拒绝浏览器 Origin；不能用它充当员工登录。查询最多 20 个任务、5 分钟有效、60 秒领取租约。GitHub 文件不存在时按需创建，不预建空文件。

## 验收

测试使用临时 RSA 密钥与 mock GitHub，验证签名、PKCS#1/8、续期、并发、配置旋转、固定仓库、权限收窄、错误脱敏及身份未接入时禁止数据访问。测试不会使用真实凭据或写业务仓库。

只有管理员实际安装与配置成功、接入员工身份、再通过手机扫码查询和无照片批次保存测试，才算整体上线完成。源码部署成功或 /api/session 的 configured:true 不证明 GitHub 写权限已实测。
