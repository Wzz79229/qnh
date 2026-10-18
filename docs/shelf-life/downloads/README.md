# 鲜期 Android

当前版本：[鲜期 0.2.0 APK](./xianqi-0.2.0.apk)，约 33.3 MB，Android 8 及以上。

先卸载旧的 0.1.0 临时签名验证版，再安装本版并重新登录牵牛花。0.1.0 尚未存储批次；0.2.0 起固定签名，后续同签名版本可覆盖升级。已有待同步批次时请勿卸载或清除应用数据。

本版包含：手机内牵牛花登录、扫描 SKU 即时查询商品、拍照在本机识别生产日期/保质期、自动计算到期日期、填写清点件数、加密本机草稿、云端连接与重试同步入口。包装照片只在内存识别，不保存、不上传。

云端商品主图与批次功能需要管理员完成 Cloudflare D1 和私有 R2 绑定，并通过手机实际租户验证；未完成时只会保存本机草稿，明确显示待同步。当前已部署接口报告 configured:false，云端保存尚未开通。

APK 已通过编译、Android lint 和 APK v2/v3 签名校验；新相机/OCR、云端会话核实仍需手机实测。校验值见 SHA256SUMS.txt。

SHA-256：eb37430f95c97194a5e99b93e912c6f79b10f1df1367bd4616ed7d91485c5aee

[云端配置步骤](https://github.com/Wzz79229/qnh/blob/main/apps/qnh-shelf-life/backend/MOBILE-CLOUD.md)

旧版仅供兼容验证：[0.1.0](./xianqi-phone-validation-0.1.0.apk)。
