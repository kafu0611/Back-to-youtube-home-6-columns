# Back-to-youtube-home-6-columns

一个用于整理 YouTube 主页的用户脚本：固定六列视频布局、隐藏 Shorts
与插入型货架，并将“2 年前”等模糊发布时间替换为具体日期。

当前版本：`0.3.1`

## 功能

- **固定六列布局**：覆盖 YouTube 的响应式列数，使主页每行显示六个视频。
- **统一卡片尺寸**：将强调卡片和超大卡片恢复为普通宽度。
- **隐藏 Shorts**：隐藏主页中的 Shorts 货架。
- **隐藏插入分区**：默认隐藏分类货架、问卷、重大新闻等
  `ytd-rich-section-renderer` 分区。
- **显示精确发布日期**：例如将“2 年前”替换为 `2023-11-04`。
- **适配动态加载**：支持 YouTube SPA 导航和无限滚动中新加入的视频卡片。
- **仅影响主页**：离开 `/` 后立即取消六列和隐藏样式，不影响订阅页等页面。

## 安装

1. 安装用户脚本管理器，例如
   [Tampermonkey](https://www.tampermonkey.net/)、
   [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开
   [youtube-home-6cols-clean.user.js](https://raw.githubusercontent.com/kafu0611/Back-to-youtube-home-6-columns/main/youtube-home-6cols-clean.user.js)。
3. 在用户脚本管理器中确认安装或更新。
4. 打开 `https://www.youtube.com/`，然后强制刷新页面。

若正在测试尚未合并的 PR，请从对应 PR 分支的 Raw 文件安装，而不是使用上面的
`main` 链接。

## 配置

编辑脚本顶部的常量即可调整行为：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `COLS` | `6` | 主页每行显示的视频数量 |
| `ENABLE_UNIFORM_EMPHASIS` | `true` | 将强调/超大卡片压回普通宽度 |
| `ENABLE_EXACT_PUBLISH_DATE` | `true` | 将相对发布时间替换为精确日期 |
| `HIDE_ALL_SECTIONS` | `true` | 隐藏所有插入型分区；设为 `false` 可保留“继续观看”等普通分区 |
| `DATE_FETCH_CONCURRENCY` | `3` | 同时获取发布日期的最大请求数 |
| `DATE_CACHE_LIMIT` | `500` | 本地最多缓存的日期记录数 |
| `DATE_MAX_RETRIES` | `2` | 瞬时网络或配置错误的最大重试次数 |

## 精确发布日期如何工作

脚本只在普通视频卡片进入视口时请求日期，不会提前处理用户尚未看到的无限滚动
内容。它读取 YouTube 页面自带的 Innertube 配置，通过轻量的
`/youtubei/v1/player` 接口取得
`microformat.playerMicroformatRenderer.publishDate`，不会下载并解析完整观看页。

日期以 `YYYY-MM-DD` 格式显示。鼠标悬停在日期上时，标题提示中仍会保留原来的
相对时间。

以下内容会保持原样：

- Mix 和播放列表卡片；
- 直播或没有正常发布日期的卡片；
- 没有可识别相对时间字段的特殊卡片。

成功日期和“无可用日期”的结果会缓存在 YouTube 域名下的 `localStorage` 中，
避免在新标签页或重新进入主页时重复请求。脚本不需要用户提供 YouTube API key，
也不会向第三方服务发送视频列表。

## 故障排查

### 日期仍显示为“2 年前”

1. 在脚本管理器中确认脚本版本为 `0.3.1` 或更新版本。
2. 确认当前地址是 YouTube 主页 `https://www.youtube.com/`。
3. 强制刷新页面；日期会在卡片进入视口并完成请求后出现。
4. Mix、播放列表、直播和特殊卡片不会被替换，这是预期行为。

如果需要清空日期缓存，可在 YouTube 页面的开发者工具控制台执行：

```js
localStorage.removeItem('ytg-publish-date-cache-v1');
```

随后刷新主页。

### “继续观看”等分区消失

这是 `HIDE_ALL_SECTIONS = true` 的默认行为。将其改为：

```js
const HIDE_ALL_SECTIONS = false;
```

即可保留普通分区，同时继续隐藏 Shorts 和已知分类货架。

### YouTube 更新后脚本失效

YouTube 会不定期调整页面 DOM 和内部接口。请在仓库中提交 Issue，并附上浏览器、
脚本管理器、脚本版本以及出现问题的卡片类型。

## 权限与兼容性

- 脚本使用 `@grant none`，不申请额外用户脚本权限。
- 建议使用最新版 Chrome、Edge、Firefox 或其他现代浏览器。
- 日期功能依赖 YouTube 当前的内部 player 接口；接口发生变化时可能需要更新脚本。

## License

本项目使用 [MIT License](LICENSE)。
