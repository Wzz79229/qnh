# 库位标签图片生成器

公开访问：https://wzz79229.github.io/qnh/label-maker/

在同一输入区粘贴整段商品信息并添加库存截图，点击“识别并生成标签”。文字中的完整商品名、规格、SKU 优先，截图补充库位等缺失信息。SKU 截断时需要补充包含完整 SKU 的文字，不会用 UPC 代替。

下载 80 × 60 mm、300 dpi 的 PNG 图片，导入得力标签 App 打印。识别在浏览器本地完成，商品文字和截图不会上传。首次图片识别需要加载 OCR 资源。

部署目录为 `docs/label-maker`，复用现有 main 分支 `/docs` 的 GitHub Pages 发布设置。更新此目录并提交后，GitHub Pages 自动发布。原有首页及商品库功能保留。

OCR 第三方组件的来源和许可见 `docs/label-maker/vendor/tesseract/NOTICE.md` 及同目录的许可文件。

