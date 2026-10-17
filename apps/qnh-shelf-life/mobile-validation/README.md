# 鲜期 · 安卓手机连接验证

此版本验证：员工在自己安卓手机的 WebView 中登录官方牵牛花，自动识别本机页面的当前租户，然后输入真实 SKU 查回名称、规格和商品图片。登录与查询在手机执行，不调用 Cloudflare Browser Run。

当前阶段不是完整保质期管理版本：暂不接入扫码、拍照识别或 GitHub 批次读写。手机 DOM 中的租户仅用于本机查询边界，不作为后台授权；后续必须先完成独立可验证的服务端租户身份验证，才能读取或保存私有 bzq 数据。不会把客户端提交的 tenantId 当成已认证身份。

## 安装验证

1. 从 GitHub Actions 的 `Build Xianqi Android validation APK` 成功运行中下载 `xianqi-phone-validation-0.1.0`，解压 APK。
2. 在 Android 8 或更新的手机安装 `xianqi-phone-validation-0.1.0.apk`。这是验证包，安装来源只需允许负责打开该 APK 的应用；用完可关闭。
3. 打开“鲜期·手机验证”，在官方牵牛花页面亲自登录。不要发送密码、验证码或 Cookie。
4. 成功后应自动进入商品查询界面。输入一个真实 SKU，点击“查询商品”，核对名称、规格和图片。查询期间可看到真实牵牛花页面；页面过小可双指缩放。
5. 如果登录不兼容、不能返回查询界面或查不到商品，只需反馈出错步骤和页面提示，不要导出登录信息。

APK 使用 CI 临时调试签名，且关闭 debuggable / WebView 远程调试。不同构建的签名可能不同，升级验证包时可能需要先卸载旧包，届时本机牵牛花登录会清除。正式版将另外配置稳定的签名与分发流程。

## 数据边界

- 只向牵牛花官方页面进行正常登录、SKU 查询；商品图片仅允许 HTTPS `img.meituan.net`。
- 没有 JS 到原生的特权接口，不读取 Cookie / 密码 / 请求头，不把登录信息提交到鲜期后台。
- 不开放文件访问、HTTP 明文、SSL 忽略或任意地址导航；不申请相机、联系人、存储权限。
- SKU 保留字符串精度，结果必须来自本次表格刷新且精确匹配 SKU；租户变化、登录失效或查询取消会丢弃结果。
- 不保存商品库、图片或批次数据。登录会话由本机 WebView 管理，可用“清除本机牵牛花登录”删除。

## 构建

JDK 17、Android SDK 35 / Build Tools 34.0.0、Gradle 8.9、AGP 8.7.3。先在上一级目录执行 `npm ci --ignore-scripts`、`node mobile-validation/build-runtime.mjs`，再在本目录运行 `gradle :app:assembleDebug :app:lintDebug`。`github-workflow.yml` 镜像到仓库根目录 `.github/workflows/xianqi-android-validation.yml`，仅有 contents:read 权限，不需要任何业务密钥。

本机构建环境：当前 Windows 没有检测到 Java / Android SDK，APK 通过 GitHub Actions 编译。构建通过不代表已通过牵牛花真人登录与实机验收。
