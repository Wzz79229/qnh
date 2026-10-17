# 本机牵牛花 SKU 查询

手机扫描牵牛花 SKU 后，Cloudflare 创建短期查询。本程序只通过 HTTPS 出站领取查询，在本机独立 Chrome/Edge 的商品主档页面搜索精确 SKU，返回名称、规格及当前商品图片。员工在手机手填清点件数。没有公网隧道，不同步整个商品库，不设置本机入站监听。

当前状态：已根据实际商品主档 DOM 实现 SKU 字段、查询按钮、嵌套规格、表格刷新和“暂无内容”空状态适配。源码和模拟测试已完成；本程序尚未连接实际手机任务进行端到端验收。不要仅凭模拟测试宣称线上已连接。

## 先连接牵牛花

暂不配置 GitHub 或 Cloudflare 时，先双击本目录的 **`连接牵牛花.cmd`**。它不要求连接密钥，也不调用云端查询队列。

Windows 启动器采用 ASCII 内容与 CRLF 换行，界面中文提示由 Node.js 程序显示；源码中的 `.gitattributes` 保持批处理换行。启动器先查找 PATH 中的 `node.exe`，再查询 Node.js 的 Windows 安装记录，兼容尚未更新 PATH 的旧桌面会话。如果旧窗口显示乱码或把 `Node.js`、`GitHub` 当作命令，请关闭旧窗口后重新双击本地更新后的入口，不必重复安装 Node.js。

1. 程序打开自己的 Edge 窗口，在窗口内亲自登录牵牛花，然后进入“商品 → 商品主档”。密码、短信验证码和牵牛花账号均不填到终端或聊天。
2. 回到终端按回车检查；出现“已识别牵牛花商品主档”后，输入一个真实的牵牛花 SKU。
3. 程序只查询该 SKU，在终端显示名称、规格和页面提供的图片链接；浏览器当前商品行可核对主图。未找到、登录失效、多个匹配或缺图会明确提示。商品结果不写文件、不发送到手机或云端。
4. 输入 `:q` 结束本次试查。日后运行 `启动查询.cmd` 时使用同一独立浏览器目录，可沿用浏览器正常保存的登录状态；网站登录过期仍须亲自重新登录。

`连接牵牛花.cmd` 和 `启动查询.cmd` 同时只运行一个。第二个程序会提示目录已占用；先退出当前程序再切换。当前应用内浏览器与这里的独立 Edge 不共享登录，本程序不会复制两者的 Cookie。

这个入口用于先验证电脑上的真实商品查询，**尚不提供员工手机的牵牛花单点登录或批次云端保存**。手机接入仍需后续身份认证及后台授权。首次在另一台电脑使用前，请完成下方依赖安装。

## 首次安装

需要 Windows、Node.js 20+、已安装的 Microsoft Edge 或 Google Chrome。

在本目录打开终端执行：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
```

依赖固定为官方 `playwright@1.64.1`，锁文件含官方 npm 地址和完整性校验（2026-10-16 核对）。程序使用已安装的 Edge/Chrome，不自动下载浏览器或安装全局组件。当前工作区已按锁文件安装依赖；下载源码到其他电脑时仍需执行上述安装。本程序尚未启动独立浏览器或完成真实手机端到端验收。来源：[官方包](https://www.npmjs.com/package/playwright)、[持久浏览器和 Chrome/Edge 通道](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。

## 管理员配置

在 Cloudflare 现有 `qnh-shelf-life-api` 的 Secrets 配置 `QNH_CONNECTOR_KEY`：至少 32 位、无空白、随机生成的连接密钥。它必须不同于 `TEAM_PASSWORD`、`SESSION_SECRET`、`GITHUB_TOKEN` 和牵牛花登录密码。该密钥只给运行本程序的管理员，不发给员工、不放进前端代码/GitHub/聊天。

具体步骤：

1. 在你自己的 Windows PowerShell 中执行下列代码。它生成新的随机连接密钥并复制到剪贴板，不在终端打印，也不写文件。

   ```powershell
   $qnhBytes = New-Object byte[] 32
   $qnhRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
   $qnhRandom.GetBytes($qnhBytes)
   $qnhRandom.Dispose()
   $qnhKey = ($qnhBytes | ForEach-Object { $_.ToString('x2') }) -join ''
   Set-Clipboard -Value $qnhKey
   Remove-Variable qnhBytes, qnhRandom, qnhKey
   ```

2. 打开 Cloudflare → Workers & Pages → `qnh-shelf-life-api` → Settings → Variables and Secrets → Add。名称填 `QNH_CONNECTOR_KEY`，类型选 **Secret**，粘贴剪贴板中的值并 Deploy。
3. 双击本目录 `启动查询.cmd`，在遮罩输入提示中粘贴**同一个**连接密钥。若要留存它供下次启动使用，请自行存入密码管理器；程序不会替你写入源码或磁盘。

双击 `启动查询.cmd`。若当前环境没有密钥，脚本用 Windows 密码输入框方式在终端遮罩输入，只传给本次程序进程，不写磁盘。不要把牵牛花密码填在该处。

默认服务为 `https://qnh-shelf-life-api.w792294944.workers.dev`。可明确设置 `QNH_API_BASE_URL` 为其他 HTTPS 根地址，不接受明文 HTTP、查询串、凭据或非根路径。默认 `QNH_BROWSER=msedge`；可设为 `chrome`。启动前两者作为普通环境变量设置即可。

## 登录与运行

程序创建自己的浏览器目录 `%LOCALAPPDATA%\QnhShelfLife\QueryBrowser-msedge`（Chrome 使用 `QueryBrowser-chrome`）。不会打开、复制或连接你日常浏览器的用户目录。第一次需要你本人在这个独立窗口登录牵牛花，输入密码及验证码，然后进入“商品 → 商品主档”。

浏览器自身会在该独立目录保存普通登录资料。本程序不导出、不读取、不上传 Cookie、localStorage、storageState 或账号密码；不访问隐藏接口、网络响应或页面内部状态。不要把该目录打包、上传到 GitHub或共享给员工。

程序通过已授权的连接密钥逐个领取查询。登录失效时，在本机提醒管理员，并向手机明确返回“需要重新登录”，不搜索或读取页面商品，不提交任何账号凭据。确认商品页可操作后才通过可见 UI 只读搜索，不修改商品或库存。程序不会用 SKU 代替条码，也不会从本地商品快照返回旧结果。独立窗口用于程序查询，运行期间不要手工改变筛选条件；首次登录进入商品主档后应保持默认筛选。

每次查询均重新填写已核验的 SKU 字段并点击“查询”。只在商品表相关加载容器里观察 DOM 刷新，并等待加载结束和表格稳定；没有观察到刷新、出现未知空白或查询超时，都明确报错，不返回上一次查询的商品。商品信息只读取商品/规格两列及主图，不读取价格、操作人或其他业务列。

查询输出区分：精确找到、未找到、多重匹配、需要登录、图片缺失或页面异常。图片只接受页面实际提供的无凭据、无查询参数的 `https://img.meituan.net/` 地址，不猜原图地址。

保持电脑、浏览器窗口及程序运行。关闭浏览器或按 Ctrl+C 即停止；电脑休眠、断网或退出后手机查询不能继续。本机启动不代表 Cloudflare 桥接接口已经部署；两端配置及实机验收均完成才算可用。

## 协议与测试

- `POST /api/qnh/bridge/claim`：无请求体，`Authorization: Bearer QNH_CONNECTOR_KEY`，返回 `{job:{id,sku,leaseToken}|null}`。
- `POST /api/qnh/bridge/result`：提交 `{id,leaseToken,result}`。只提交白名单商品字段，不提交页面 HTML、密码、任意异常文本或浏览器资料。
- 网络请求拒绝重定向、最长 8 秒；商品查询预算 35 秒，避免提交过期租约。提交未确认不会假报成功；服务暂时不可用时有间隔地重试领取。
- SKU 始终是原始字符串，不转为数字。仅按实际 SKU 字段精确匹配；不能仅按名称、条码或 SPU 相同判成功。

项目根目录运行 `node --test tests/local-query.test.mjs`。这些测试完全注入 mock，不安装依赖、不启动浏览器、不联网。

