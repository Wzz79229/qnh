# 鲜期 · 拍照保质期管理

拍商品包装，识别商品名称、生产日期与保质期，确认后建立商品批次。日常页面没有手动商品录入、表格导入或 GitHub 令牌填写。

## 当前状态

拍照和本机识别已实现；本机浏览器已用明确标注的合成包装测试图跑通识别流程。真实包装受印刷、反光、清晰度与标签格式影响，需要实际试拍；不完整或冲突的结果会要求补拍。

**Cloudflare 同域 PWA 与后台已完成首次部署，尚未配置私有数据授权，也未完成团队共享验收。** 运行时目前只有 `ASSETS` 和 `ALLOWED_ORIGIN`，三个 Secret 尚未配置；浏览器访问 `/api/session` 已返回 `SETUP_REQUIRED`。部署成功不代表已连接 `bzq` 或已保存团队数据。

Cloudflare 入口：[鲜期 App](https://qnh-shelf-life-api.w792294944.workers.dev/)。首次部署源码为 `main:b5a6096ad1dbb36952551b6b5b8c71c4ffbda553`，版本为 `ddf79631-81df-4273-86cf-7a84cd66e897`。

原 [GitHub Pages 入口](https://wzz79229.github.io/qnh/shelf-life/) 仍保留空的连接配置。尚未连接时，照片草稿只留在当前打开的页面；刷新、关闭或手机回收页面会丢失未备份草稿。不能将聊天工具的 GitHub 授权复制给网页，也不能把后台密钥写进页面。

## 拍照使用

1. 点“拍照建档”，拍清包装上的产品名称或品名标签。
2. 日期和保质期不在同一位置时可补拍；同一批次最多 3 张。
3. 点“识别包装信息”。照片在浏览器本地运行 OCR，不发送到第三方识别服务，不需要 AI 接口令牌。
4. 核对只读结果。日期含糊、多个日期冲突、缺少名称或保质期时请补拍，不猜测或手动补写。
5. 团队后台连接成功时确认保存；尚未连接时只能“确认，暂存本页”，可下载含压缩照片的草稿备份。

每次确认建立一个拍照批次，不推断实际库存数量。默认紧急临期 7 天、即将临期 30 天；日期按北京时间计算，到期当天单独提醒。明确标注的到期日期优先，按月或年计算时超出目标月份天数取月末；请始终核对包装实际截止日。

## GitHub 文件位置

| 内容 | 位置 |
| --- | --- |
| 源代码、测试、部署准备 | `Wzz79229/qnh/apps/qnh-shelf-life/` |
| Pages 发布文件 | `Wzz79229/qnh/docs/shelf-life/` |
| 正式批次数据 | 私有 `Wzz79229/bzq/main/data/shelf-life.json` |
| 压缩包装照片 | 私有 `Wzz79229/bzq/main/photos/<uuid>.jpg` |

现有批次仍可查看、处理与恢复。照片在私有仓库中单独保存，记录只保留经过校验的 `photoRefs:[{id,path}]`。单张归档 JPEG 不超过 300 KiB，输入照片每张最多 10 MiB；识别图最长边 1600 像素。

共享保存先上传不可变照片，再用预期 SHA 保存记录。多人版本冲突时保留本页草稿，不覆盖同事修改。照片与记录是分开提交，记录保存失败可能留下无引用照片；不会自动删除照片。GitHub JSON 数据文件上限为 1 MB。

## 管理员一次配置

`backend/` 提供固定读写 bzq 的 Cloudflare Worker，部署与 Secret 配置见 [backend/README.md](backend/README.md)。成员不需要 GitHub 令牌；后台独立保管一次管理员授权。

Cloudflare 将 PWA 和 API 放在同一个 Worker 域名，避免手机第三方 Cookie 限制。Git Build 使用 `apps/qnh-shelf-life/backend` 为根目录，构建时仅将 Cloudflare 部署产物 `../dist/connection.json` 的 `apiBase` 改为 `/`；GitHub 源码及 Pages 的空连接配置不变。具体命令见后台说明。管理员配置 Secret 后，还需验收团队登录、照片保存及另一台手机读取。源码和业务数据继续在 GitHub，后台不另建业务数据库。

没有配置后台就不声称已经自动连接。不要将 GitHub 令牌、团队密码或会话密钥发到聊天、放入前端文件或提交到 Git。

## 本地运行与验证

需要 Node.js 20 或更新版本，无需 npm install。

```powershell
npm start
npm test
```

本机预览 <http://127.0.0.1:4173>，只监听本机。测试涵盖日期、包装文字歧义、图片限制、后台会话、私有照片、数据版本冲突等；后端测试使用模拟请求，不能替代真实授权部署验收。

首次拍照识别按设备能力只选一种内嵌 WASM 的 LSTM core，再读取简中、英文两个 gzip 语言文件及 worker 脚本，文件合计约 7.8 MB（约 8 MB，实际传输量受 HTTP 压缩影响）。其他 core 变体和独立 `.wasm` 是保留的上游资源，不会全部下载用于一次识别。界面先缓存，OCR 资源使用后缓存；照片、业务接口响应和授权信息不进 Service Worker 缓存。苹果使用 Safari 分享菜单添加到主屏幕，安卓可在浏览器菜单安装或添加到桌面。

## 维护与依赖

更新源目录 `dist/` 时同时更新 `qnh/docs/shelf-life/`，沿用现有 main 分支 /docs Pages 发布配置。`apps/qnh-shelf-life/.github/workflows/pages.yml` 只用于迁移到独立仓库，不改变现有 qnh 发布流程。

Tesseract.js/core 7.0.0 与 tessdata_fast 4.1.0 简中、英文模型均内置。来源、固定版本、SHA256 与许可证见 `dist/vendor/tesseract/SOURCES.json` 及相邻 LICENSE 文件。旧版 CSV 工具和 SheetJS 源文件仅保留兼容测试，当前商品录入流程不使用它们。
