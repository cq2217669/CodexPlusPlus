# 微信 ClawBot 分享说明

## 结论

轩++当前的“微信连接”是 iLink Bot 长轮询桥接。扫码取得的是 `bot_token` 和 Bot 账号 ID，不是公开会话链接；因此，把“分享”代码写入本仓，并不能让其他人仅凭 Bot ID、登录二维码或 token 直接找到并使用该 Bot。

本仓现在提供的纯源码能力是保存、复制和打开一个**已经由外部平台提供的公开会话 URL**。管理员在“微信连接 -> 对外会话链接”填写 URL，保存后即可复制给受邀者。该功能只处理文本 URL，不会上传、生成或分享登录二维码、token、allowlist 或本机路径。

`weixinConnectShareUrl` 不是 iLink Bot 入口生成器。它需要填写由微信/iLink、公众号、小程序、已登记的移动 App 或你自己的落地页实际提供的公开 URL；没有这个外部入口时，留空即可。

## 当前实现边界

- 扫码 API 使用 `ilink/bot/get_bot_qrcode`，确认后保存 `bot_token` 和 `ilink_bot_id`：`crates/codex-plus-core/src/connect/weixin.rs`。
- 收发均使用 `ilink/bot/getupdates`、`ilink/bot/sendmessage` 与 `ilink_bot_token`：`crates/codex-plus-core/src/connect/weixin.rs`。
- 允许名单只筛选已经到达 Bot 通道的 `from_user_id`，不能创建第三方进入 Bot 会话的入口：`crates/codex-plus-core/src/connect/mod.rs`。

因此，其他开发者拉取源码后可直接使用“复制已配置 URL”这个桌面功能；要让分享链接真的在微信中打开目标会话，仍必须自行具备相应平台的公开入口和资质。

## 分享能力矩阵

| 场景 | 源码内可实现 | 必须依赖微信官方 | 启用前置条件 |
| --- | --- | --- | --- |
| 轩++桌面端复制/打开已有 URL | 保存 URL、复制到剪贴板、用系统浏览器打开 | 否；但 URL 指向的服务由其所属平台决定 | 填写真实 HTTPS 公共 URL；不得填写登录二维码或 token |
| 小程序右上角转发 | 页面配置标题、图片和路径；调用 `wx.showShareMenu`；实现 `onShareAppMessage` / `onShareTimeline` | 是。转发菜单、分享卡片和跳转由微信客户端/小程序运行环境提供 | 已注册小程序 AppID、完成开发者/主体资质与必要审核、在微信开发者工具/真机运行；路径必须是已发布或可体验的小程序页面 |
| 公众号 H5 分享卡片 | 页面调用 JS-SDK 的 `wx.updateAppMessageShareData` / `wx.updateTimelineShareData` | 是。JS-SDK 签名与微信内置浏览器能力由公众号平台验证 | 已认证公众号或具有所需 JS 接口权限；配置 JS 接口安全域名；页面为 HTTPS；服务端按当前 URL 生成 `appId`、`timestamp`、`nonceStr`、`signature`；在微信内置浏览器测试 |
| 原生 App 分享到微信 | 集成 Android/iOS 微信开放平台 SDK，构造标题、描述、缩略图和网页/小程序/媒体对象 | 是。SDK、AppID、包名/签名和平台审核不能由本仓替代 | 微信开放平台登记 AppID；配置 Android 包名与签名或 iOS Bundle ID；通过所需审核；在真机安装已签名 App；按 SDK 要求处理回调 |
| 让任意人通过 iLink Bot ID 或登录二维码进入当前 ClawBot | 否 | 是，且当前仓库未发现 iLink 提供的公开邀请/发现接口接入 | 需要微信/iLink 实际提供可公开分发的 Bot 会话链接、二维码或发现 API，并按其账号、权限和审核要求配置 |

## 微信官方文档

- 小程序页面分享：<https://developers.weixin.qq.com/miniprogram/dev/reference/api/Page.html#onShareAppMessage-Object-object>
- 小程序显示分享菜单：<https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.showShareMenu.html>
- 公众号网页 JS-SDK：<https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/JS-SDK.html>
- 微信开放平台移动应用接入：<https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html>
- 微信开放平台 iOS 接入：<https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/iOS.html>

微信官方接口、资质范围、审核规则和可用权限可能调整，应以控制台中该主体实际可见的能力和上述官方文档为准。

## 管理员启用步骤

1. 先从所用的微信官方平台或 iLink 服务取得一个可公开访问的会话/落地页 URL。
2. 在轩++“微信连接”的“对外会话链接”中粘贴该 URL，点击“保存”。
3. 点击复制图标，将 URL 发给受邀者；点击打开图标仅用于本机验证 URL。
4. 在微信目标平台验证受邀者可打开目标页面或会话，再把其 iLink user ID 加入“允许的微信用户 ID”。
5. 保持 allowlist 为精确 ID；不要长期使用 `*`，不要对外发送登录二维码、`bot_token` 或设置文件。

仅配置本仓的 URL 字段不等于完成微信侧上线。小程序、H5 和 App 仍须分别完成上表中的 AppID、域名、签名和审核流程。
