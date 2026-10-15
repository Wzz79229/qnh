# 鲜期 · 牵牛花保质期管理

手机浏览器使用的 PWA，可添加到桌面。源代码与业务数据均可保存在 GitHub；浏览器通过 GitHub Contents API 读写团队共享的 JSON 文件，不需要另外部署数据库。

应用不直接连接牵牛花系统，商品先通过手动录入或表格导入。正式业务数据需连接团队自己的私有 GitHub 仓库；演示数据与团队数据分开。

## 当前仓库部署

按用户选择，源代码放在 `Wzz79229/qnh` 的 `apps/qnh-shelf-life/`，发布文件放在独立路径 `docs/shelf-life/`，沿用仓库已有的 `main` 分支 `/docs` Pages 发布设置。

访问入口：<https://wzz79229.github.io/qnh/shelf-life/>。实际是否发布完成，以仓库 Pages 部署结果为准。

后续修改应同步 `apps/qnh-shelf-life/dist/` 与 `docs/shelf-life/` 的相同文件后提交。独立项目携带的 `.github/workflows/pages.yml` 仅供迁移到单独仓库时使用，在现有 qnh 的子目录内不会触发，不需要更改现有 Pages 设置。

团队数据使用已初始化的私有仓库 `Wzz79229/bzq`，文件为 `main` 分支的 `data/shelf-life.json`。在 App 的“团队”页填写本人的显示名称与访问令牌后连接。

## 已实现

- 按商品批次记录商品名称、条码、分类、库位、批次、日期、数量和备注。
- 填写到期日期，或由生产日期及保质期自动计算到期日期。
- 按过期、今日到期、临期及正常状态查看商品，搜索商品，记录批次处理情况。
- 导入 CSV、Excel `.xlsx` / `.xls` 的第一个工作表；导入前查看校验结果。
- 导出 Excel、CSV、备份 JSON；多人读取同一个 GitHub 数据文件，修改后自动尝试保存。
- 支持手机桌面图标及离线打开应用界面；业务数据不写入浏览器持久存储。

## 本地运行

需要 Node.js 20 或更新版本。在本项目目录执行：

```powershell
npm start
```

打开 <http://127.0.0.1:4173>。服务器只监听本机，不直接向局域网开放。无需 `npm install`，没有运行时 npm 依赖。

```powershell
npm test
```

也可以把 `dist/` 部署到支持 HTTPS 的静态网站。推荐使用下述 GitHub Pages 流程，使全部文件继续保存在 GitHub。

## 首次部署到 GitHub

建议使用两个 GitHub 仓库：

| 仓库示例 | 用途 | 建议可见性 |
| --- | --- | --- |
| `qnh-shelf-life` | 本项目源代码、PWA、Pages 工作流 | 公开，里面不放业务数据和令牌 |
| `bzq` | `data/shelf-life.json` 等团队业务数据 | 私有，仅邀请团队成员 |

两者都保存在 GitHub。公开 Pages 网站可以展示应用界面，但读取私有数据仍需有权限的个人令牌。若只使用一个公开仓库，放入其中的业务数据也会公开。

1. 在 GitHub 创建代码仓库，以 `main` 为默认分支。将本项目目录的**内容**上传到仓库根目录：根目录应能看到 `dist/`、`package.json` 与 `.github/workflows/pages.yml`。使用 Git 推送可完整保留隐藏的 `.github` 目录。
2. 在代码仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Actions → Deploy 鲜期 to GitHub Pages** 手动运行工作流。之后推送 `dist/` 或工作流文件的变更会自动部署。工作流仅发布 `dist/`，不会将整个代码仓库发布到网站。
4. 部署成功后，在 Pages 设置或工作流的 `github-pages` 环境里打开实际网址。项目网址通常形如 `https://你的用户名.github.io/qnh-shelf-life/`，以 GitHub 返回的网址为准。
5. 当前团队的私有数据仓库 `Wzz79229/bzq` 与 `main` 分支、`data/shelf-life.json` 已初始化。若迁移到其他新仓库，请先创建仓库并勾选添加 README，使 `main` 分支存在；首次连接时会创建尚不存在的数据文件。
6. 在数据仓库的 **Settings → Collaborators** 或组织的成员/团队设置里邀请成员，并给予允许写入目标分支的权限。成员需要先接受邀请。

GitHub Pages 的可用仓库类型与访问控制取决于账号计划。即使代码来自私有仓库，也不要默认认为 Pages 网站自动私有。参见 [GitHub Pages 入门](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)与[自定义工作流部署](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 连接共享数据

每位成员使用自己的 GitHub 账号与令牌，不共享个人令牌。在应用连接设置中填写：

| 设置 | 示例 |
| --- | --- |
| 仓库所有者 | `your-github-name` 或组织名，不填网址 |
| 数据仓库 | `bzq` |
| 分支 | `main`，必须已存在 |
| 数据文件 | `data/shelf-life.json` |
| 操作人 | 便于自己识别的姓名或昵称 |
| GitHub 令牌 | 当前成员有权读取、写入数据仓库的个人访问令牌 |

### 令牌权限

仓库所有者，或 GitHub 支持的组织成员场景，优先创建 **fine-grained personal access token**：选择正确的 Resource owner，仅授权数据仓库，并给 **Repository permissions → Contents → Read and write**。组织可能要求审批或额外授权；组织策略和分支规则也可能阻止直接写入。

GitHub 对 fine-grained 令牌仍有场景限制，尤其是自己不属于该组织的 outside collaborator，或访问另一个个人账号拥有的协作仓库，不能默认适用。请按 GitHub 当时的支持范围与组织策略选择；需要 classic token 时，私有仓库通常要求 `repo` 范围，其权限更宽，应选短有效期并妥善保管。令牌不会赋予账号本来没有的仓库权限。详见 [GitHub 官方个人访问令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

令牌只保存在当前页面会话的内存中，不写入源代码、GitHub 文件、Local Storage、IndexedDB 或 Service Worker 缓存。刷新、关闭或重新打开应用后需要重新输入。浏览器只记住仓库、分支、文件路径及操作人等非秘密连接偏好。不要将令牌贴入业务数据、备注或代码。

### 多人协作与保存

1. 连接后拉取云端数据，再录入或修改。
2. 变更先在当前页面中形成草稿，连接后会自动尝试保存。收到保存成功提示，才表示已写入 GitHub；失败时可在团队页面点击“保存草稿”重试。每次保存会生成 Git 提交，可在仓库历史中查阅和恢复。无未同步草稿且未编辑时，每分钟检查团队更新。
3. 保存前检查文件 SHA 版本，写入时也提交预期 SHA。若其他成员先保存，应用会阻止覆盖，保留当前页面草稿；先导出草稿备份，再拉取最新数据，核对后重新录入自己的改动。应用不会自动合并或强制覆盖冲突。
4. 保存遇到网络中断或超时，实际 GitHub 请求可能已经成功。先保留草稿并拉取云端核对结果，避免直接重复操作。

没有后台同步、实时推送或独立的应用账号系统。GitHub 控制访问权限，操作人昵称仅是界面设置，不是身份验证。不要把需要逐笔审计的业务流程仅依赖操作人昵称。

## 表格导入

下载应用中的 CSV 模板，或使用 `dist/import-template.csv`。模板只有中文表头，没有商品示例数据。可在 Excel 中打开后填写，再保存为 `.xlsx` 或 UTF-8 CSV。导入 Excel 时只读取第一个工作表。

必填内容为 **商品名称、数量，以及到期日期**；如果不填到期日期，则填写 **生产日期、保质期、保质期单位**。每一行是一条独立商品批次。

| 列 | 填写方式 |
| --- | --- |
| 商品名称 | 必填文字 |
| 数量 | 必填，0 或更大的数字 |
| 到期日期 / 生产日期 | 建议 `2026-10-15`；也支持常见日期文本和 Excel 日期 |
| 保质期 | 正整数；有到期日期时可留空 |
| 保质期单位 | `天`、`月` 或 `年`；未填写时默认按天 |
| 条码 | 建议在 Excel 中设置为文本，保留前导 0 和长条码 |
| 分类、库位、批次、单位、备注 | 按需填写；单位默认 `件` |
| 编号、状态、处理原因、处理时间、更新时间、删除时间 | 新增商品一般留空；导出的备份会带这些字段 |

模板完整列顺序：`编号,商品名称,条码,分类,库位,批次,生产日期,保质期,保质期单位,到期日期,数量,单位,备注,状态,处理原因,处理时间,更新时间,删除时间`。

请先修正全部错误再导入。导入是追加批次，不按条码覆盖已有商品；遇到名称或条码、批次、库位、到期日均相同的记录，默认勾选“跳过可能重复的批次”。确认是不同批次时可取消勾选。已有编号不会直接覆盖当前记录。JSON 备份导入也追加记录，保留当前团队提醒规则。

默认预警为 30 天内临期、7 天内紧急，可在应用中调整。日期按北京时间计算：到期当天显示今日到期，次日开始过期。按天计算时为生产日期加保质期天数；按月、年计算超出目标月份天数时取月末。包装标注的截止日期优先，遇到商品行业规则不同的情况请直接填写实际到期日期。

## 添加到手机桌面

- **iPhone / iPad**：在 Safari 打开已部署的 HTTPS 网址，点分享，选择“添加到主屏幕”。
- **Android**：在 Chrome 等支持 PWA 的浏览器中打开 HTTPS 网址，通过菜单的“安装应用”或“添加到主屏幕”安装。名称会随浏览器版本变化。

首次联网打开后，Service Worker 缓存应用界面、图标和本地 Excel 导入脚本。缓存只匹配应用自身的静态资源；GitHub API 响应、令牌与业务数据不进入该缓存。

**离线时仍打开着的页面保留当前内存草稿；刷新或重新打开后不会恢复业务数据。** 重新加载共享数据、保存到 GitHub 都需要网络。离开页面前先保存，或导出备份；浏览器的离开提醒无法保证覆盖手机强制退出、系统回收页面等情况。此版本没有锁屏推送或后台到期通知，请打开应用查看预警。

## 数据格式与维护

云端文件使用 UTF-8 JSON，结构如下（示意，不是已创建的数据）：

```json
{
  "schemaVersion": 1,
  "records": [],
  "settings": { "urgentDays": 7, "warningDays": 30 },
  "updatedAt": "2026-10-15T00:00:00.000Z"
}
```

数据文件上限为 1 MB。随着批次增多，应定期导出备份，核对后归档旧记录。不要向仓库上传令牌或未经确认的真实业务数据。Git 历史会保留旧版本，删除当前文件中的记录不会自动清除历史。

源码直接使用浏览器 ES Modules，无需打包。更改静态资源后建议同时递增 `dist/sw.js` 的缓存版本，以清理旧缓存。`server.cjs` 只提供 `dist/` 中的静态文件，拒绝目录穿越与目录列表。

## 第三方组件与参考

- Excel 导入使用本地内置 [SheetJS Community Edition 0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/standalone/)，来源为官方 CDN `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`；Apache 2.0 许可证随附于 `dist/vendor/LICENSE.sheetjs.txt`。文件导入在浏览器本地处理，不上传到第三方解析服务。
- GitHub 读写接口参考 [Repository contents API](https://docs.github.com/en/rest/repos/contents)。
