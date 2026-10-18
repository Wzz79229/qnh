# 库管 Android · 首个正式版本

当前发布构建 **0.8.6（versionCode 17）**，最低 Android 8.0。沿用原包名和签名，可覆盖安装已有库管。

[下载 APK](https://wzz79229.github.io/qnh/shelf-life/downloads/kuguan-0.8.6.apk) · [下载与校验说明](https://github.com/Wzz79229/qnh/tree/main/docs/shelf-life/downloads)

## 当前功能

- 在手机内的牵牛花官方网页完成登录；显示当前账号，登录后通过过渡界面返回库管，查询期间隐藏官方网页。登录状态和查询按租户区分。
- 单个输入框查询名称、SKU、商品条码或库位，支持更改识别类型；手工输入字母自动大写。**单击继续编辑，双击全选整个查询内容。**
- 相机使用 CameraX 1.4.2，条码由本机 ZXing 3.5.3 识别；提供补光、对焦、放大和拍照扫码，不上传相机画面。扫码结果不显示内部 SKU: 查询前缀。
- 名称、SKU、完整库位查询使用“库存查询（新）”；A10 等整区库位使用“库存 → 库存查询”，直接提交库位首段筛选。
- 整区查询优先使用官方页面本次 /api/v1/comprehensive/stock/querystock 的返回数据，每页整体传给安卓端，不逐项打开商品流水。观察已有请求，不导出 Cookie、不重放请求；响应不适配时退回页面核对流程。长 SKU 保留字符串精度。
- 单条结果自动出图，多条结果可勾选生成。标签纵向排列，最新添加的批次置顶；同一整区批次按库位自然升序。查询失败保留已有标签。
- 标签为 80×60 mm、945×709 像素、300 DPI，白底黑字。名称完整换行，规格可选，文字显示 SKU: 加后六位，Code128 条码保留完整 SKU，底部显示库位。
- 一键将所有标签分别保存为 PNG，支持多图分享；导出 PDF 时每张标签独占一个 80×60 mm 页面。没有 ZIP 或 App 内直接打印功能。

当前启用库位标签功能；保质期功能暂停，未启用旧云端浏览器流程。

## 构建

项目根目录为 apps/qnh-shelf-life。需要 Node.js 20+、JDK 17、Gradle 8.9、Android SDK 35。

```sh
npm ci --ignore-scripts
node --test mobile-validation/tests/*.test.mjs
node mobile-validation/build-runtime.mjs
cd mobile-validation
gradle --no-daemon :app:testReleaseUnitTest :app:assembleRelease :app:lintRelease
```

CI 输出未签名 APK，仅用于开发验证；可安装的正式包见上方下载入口。正式包使用受控本地签名，私钥、签名密码和运行凭据不提交仓库。

正式构建保留默认、简繁中文和英文资源、全部屏幕密度和两种 ARM 架构；采用 AAPT2 资源路径压缩、ZIP 压缩及 APK v2/v3 签名。当前 APK 为 889,943 字节（约 0.85 MiB）。

## 验证范围

当前构建已通过本地 API 35 安卓模拟器的单击/双击/键盘输入、相机与条码、完整库位、A10 跨页响应、批次顺序、多选、相册 PNG、PDF、手机登录布局、隐藏网页及重新登录检查。最终签名 APK 已验证升级安装、启动和签名。

模拟查询使用受控页面和合成数据，没有使用真实账号。实际牵牛花页面、网络和手机相机效果仍以现场使用为准。