# Android 云端批次

本接口独立于 GitHub 授权和 Browser Run；不消耗云端浏览器时长。

## 管理员配置

1. Cloudflare 账户 Workers & Pages → D1 创建数据库 xianqi-batches。进入 Console 执行 migrations/0001_mobile_batches.sql 完整内容。
2. R2 创建私有 bucket xianqi-product-images。保持 Public access / r2.dev 关闭，不绑定公开域名。如首次开通要求账单或条款，由管理员亲自决定和完成；无需升级 Browser Run。
3. Worker qnh-shelf-life-api → Settings / Bindings，绑定 D1 名 FRESH_DB、R2 名 PRODUCT_IMAGES，分别选择上述资源。部署后访问 /api/mobile/config，应返回 configured:true。
4. 将实际 database_id（资源标识，并非密码）和 bucket 名加入 wrangler.toml 后再进行下一次 Git 构建，防止后续部署丢失绑定。示例配置见下文。首次迁移只需执行一次；后续迁移须追加新文件。
5. 手机进入已登录租户，连接云端并阅读会话核实说明后同意。必须通过 QNH 实际服务端校验才能保存批次；尚未实测通过前不能宣称云端已可用。

添加到 wrangler.toml 的配置（用真实数据库 ID 替换占位符，不能原样部署）：

```toml
[[d1_databases]]
binding = "FRESH_DB"
database_name = "xianqi-batches"
database_id = "<actual D1 database ID>"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "PRODUCT_IMAGES"
bucket_name = "xianqi-product-images"
```

## 身份与数据

POST /api/mobile/sessions 接受员工同意后的瞬时 QNH 会话，固定 POST https://qnh.meituan.com/api/v1/isLogined。只接受 code=0、logined=true、有效 accountId 和预期 tenantId 一致的官方响应；不存在匿名或客户端自行声明的租户授权。接口于 2026-10-18 从 QNH 官方公开 home JS 确认，匿名结果 logined=false；没有官方长期兼容保证，仍需带登录手机验证。Cookie 不入库，不记录响应或请求内容。

自有会话 1 小时，D1 仅保存令牌摘要；每分钟每来源最多 6 次会话验证以防滥用，不设置每日试用次数。批次、图片读取与写入均从该服务端会话获得租户，并核对 X-QNH-Tenant。

POST /api/mobile/batches 仅接受批次 ID、商品快照、日期、保质期和件数；服务端重新校验并计算到期日期。先归档商品主图到私有 R2，再写 D1；重复 ID 内容相同返回既有批次，内容不同返回冲突。本机只在成功响应后标记已同步。两种存储无跨服务事务；极端写库失败可能留下暂未引用的图片，但不会误报批次成功。

GET /api/mobile/batches 返回当前租户最近 100 条；GET /api/mobile/images/<hash>.<ext> 先验证同租户数据库引用，再读取私有 R2，禁止公开缓存。DELETE /api/mobile/session 可撤销当前自有会话。

## 验证

node --test tests/mobile-cloud.test.mjs tests/backend.test.mjs tests/backend-phone-login.test.mjs

测试使用真实内存 SQLite 和模拟 QNH / R2，覆盖租户隔离、过期、伪造租户、图片归档、幂等、日期与件数重算、失败保留、请求速率和退出；不使用真实员工会话。
