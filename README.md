# Back-to-youtube-home-6-columns

一个轻量的 YouTube 主页用户脚本（约 160 行，无依赖）：

- 固定每行显示六个视频；
- 隐藏 Shorts 和插入型分区；
- 将“2 年前”等模糊时间替换为具体发布日期；
- 支持 YouTube SPA 导航和无限滚动。

当前版本：`0.5`

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或
   [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开
   [youtube-home-6cols-clean.user.js](https://raw.githubusercontent.com/kafu0611/Back-to-youtube-home-6-columns/main/youtube-home-6cols-clean.user.js)。
3. 确认安装，然后刷新 `https://www.youtube.com/`。

测试尚未合并的 PR 时，请从对应 PR 分支的 Raw 文件安装。

需要支持 CSS `:has()` 的浏览器（Chrome/Edge 105+、Firefox 121+、Safari 15.4+）。

## 配置

脚本顶部只有三个常用选项：

```js
const COLS = 6;
const ENABLE_UNIFORM_EMPHASIS = true;
const ENABLE_EXACT_PUBLISH_DATE = true;
```

- `COLS`：每行视频数量。
- `ENABLE_UNIFORM_EMPHASIS`：将强调卡片恢复为普通宽度。
- `ENABLE_EXACT_PUBLISH_DATE`：显示精确发布日期。

## 工作方式

布局部分只有一段 CSS。样式在 `<html>` 出现时立即注入，并靠 `<html>` 上的
`data-ytg-home` 开关控制生效范围，因此不会先闪一次默认列数，离开主页时也会
自动失效。

日期功能只处理进入视口的普通视频卡片：`IntersectionObserver` 负责判断“该取
哪张卡”，`MutationObserver` 负责在无限滚动、SPA 导航后重新登记卡片。日期通过
YouTube 页面自带的 Innertube player 接口读取，并在当前页面内按视频 ID 缓存，
同一个视频不会重复请求。替换时原来的相对时间会存进 `title`，鼠标悬停仍可看到。

Mix、播放列表、直播和没有普通相对时间字段的卡片会保持原样。请求失败或返回的
日期格式不合预期时也会保留原来的“2 年前”等文字，不会重试或下载完整观看页。
离开主页时脚本会把改过的文字还原回去。

脚本不需要用户提供 API key，不使用第三方服务，也不保存浏览记录。

## 注意

- 脚本只在 YouTube 主页 `/` 生效。
- 默认隐藏所有 `ytd-rich-section-renderer` 分区，其中也可能包括“继续观看”等内容。
- YouTube 调整页面结构或内部接口后，日期功能可能需要更新。

## 更新记录

- `0.5`：精简约三分之一代码；样式改为尽早注入，避免列数闪烁；卡片登记改为统一
  重扫，被 YouTube 回收复用的卡片也能刷新日期。
- `0.4`：新增精确发布日期。

## License

[MIT License](LICENSE)
