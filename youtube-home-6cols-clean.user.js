// ==UserScript==
// @name         Back-to-youtube-home-6-columns
// @namespace    yt-home-6cols-clean
// @version      0.3
// @description  固定 YouTube 主页六列、隐藏插入货架，并显示视频的精确发布日期
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  // 配置
  const COLS = 6;                 // 主页每行视频个数
  const ENABLE_UNIFORM_EMPHASIS = true; // 把“强调/超大卡片”也压回普通宽度（更整齐）
  // true：整体隐藏 ytd-rich-section-renderer（省心，但“继续观看”等区块也会一起消失）
  // false：只按已知类型逐个隐藏货架，保留其他 section
  const HIDE_ALL_SECTIONS = true;
  const ENABLE_EXACT_PUBLISH_DATE = true;
  const DATE_FETCH_CONCURRENCY = 3;      // 限制同时请求数，避免滚动时集中请求
  const DATE_PREFETCH_MARGIN = '200px';  // 预取距离；调大会为用户未必看到的卡片提前发请求
  const DATE_CACHE_LIMIT = 3000;         // 本地缓存条目上限

  const STYLE_ID = 'yt-home-6cols-clean-style';
  const HOME_ATTR = 'data-ytg-home';
  const DATE_STATUS_ATTR = 'data-ytg-date-status';
  const DATE_VIDEO_ATTR = 'data-ytg-date-video';
  const DATE_ORIGINAL_ATTR = 'data-ytg-relative-date';
  const DATE_CACHE_KEY = 'ytg-publish-dates-v1';
  // 发布日期是不可变的，但“查过且确实没有日期”也需要记住，否则会反复重抓
  const DATE_UNAVAILABLE = '-';

  const dateCache = new Map();
  const dateRequests = new Map();
  const dateQueue = [];
  let activeDateFetches = 0;
  let cacheLoaded = false;
  let cacheSaveTimer = 0;
  let innertubeConfig = null;

  // 只在主页生效（YouTube 主页路径仅为 '/'）
  const isHome = () => location.pathname === '/';

  // 注入 CSS（只改变量，不改 display）
  // 所有规则都限定在 :root[data-ytg-home="1"] 下，避免离开主页后样式仍残留在
  // 同样使用 ytd-rich-grid-renderer 的其他页面（如订阅页）上。
  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
/* 固定主页 6 列（覆盖内部断点逻辑） */
:root[${HOME_ATTR}="1"] ytd-rich-grid-renderer {
  --ytd-rich-grid-items-per-row: ${COLS} !important;
}

/* 让卡片不要被内部 max-width/缩放约束住 */
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer {
  max-width: none !important;
  transform: none !important;
  zoom: 1 !important;
}

/* 可选：把“强调/超大卡片”恢复为普通卡（避免一行只剩它一个） */
${ENABLE_UNIFORM_EMPHASIS ? `
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[is-emphasized],
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[lockup] {
  contain: content;
}
` : ''}

/* 立即隐藏已知的货架组件（CSS 能直接命中的先处理） */
/* Shorts 行有时不是包在 rich-section 里，而是直接嵌在 rich-item 里 */
:root[${HOME_ATTR}="1"] ytd-reel-shelf-renderer,
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer:has(ytd-reel-shelf-renderer) {
  display: none !important;
}
${HIDE_ALL_SECTIONS ? `
/* 主页网格里的推荐视频卡片是 ytd-rich-grid-renderer 的直接子项；被 ytd-rich-section-renderer
   包起来的则是“插入型”内容（Shorts 行、分类货架 rich-shelf、chips-shelf-with-video-shelf、
   inline-survey 反馈问卷、“重大新闻”等）。整体隐藏这个容器，就不用为 YouTube 新增的每种
   货架组件逐一维护选择器。
   注意：rich-shelf 展开后其内部同样用 ytd-rich-item-renderer 渲染货架里的视频，所以
   “rich-item 一定不在 rich-section 里”并不成立——observeVideoCards 里的 closest() 判断
   正是为了排除这些货架内部的卡片。 */
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer {
  display: none !important;
}
` : ''}

/* JS 标记的目标统一隐藏 */
:root[${HOME_ATTR}="1"] [data-ytg-hide="1"] { display: none !important; }
`;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.documentElement.appendChild(s);
  };

  // 通过 JS 处理语言相关的文案（例如“重大新闻”）
  const labelsTopNews = [
    '重大新闻', '重大新聞', 'Breaking news', 'Top news', 'Headlines'
  ];

  const markShelvesByText = (root = document) => {
    // “重大新闻” 类分区：用多个候选选择器兜底，应对 YouTube 结构变更
    root.querySelectorAll('ytd-rich-section-renderer').forEach(sec => {
      const titleSelectors = [
        '#title', '#rich-shelf-header', '#shelf-title',
        'h2', 'yt-formatted-string', 'span#title'
      ];
      let title = '';
      for (const sel of titleSelectors) {
        const el = sec.querySelector(sel);
        if (el?.textContent?.trim()) {
          title = el.textContent.trim();
          break;
        }
      }
      if (title && labelsTopNews.some(t => title.includes(t))) {
        sec.setAttribute('data-ytg-hide', '1');
      }
    });
  };

  // Shorts 行的 JS 兜底：CSS 的 :has() 已经能命中，这里是给不支持 :has() 的浏览器用的
  const markReelShelves = (root = document) => {
    root.querySelectorAll('ytd-reel-shelf-renderer').forEach(el => {
      (el.closest('ytd-rich-section-renderer') ||
       el.closest('ytd-rich-item-renderer') || el).setAttribute('data-ytg-hide', '1');
    });
  };

  // 仅在 HIDE_ALL_SECTIONS 关闭时才有意义：逐类识别货架，而不是整体隐藏 rich-section
  const markKnownShelves = (root = document) => {
    root.querySelectorAll(
      'ytd-rich-shelf-renderer, ytd-chips-shelf-with-video-shelf-renderer'
    ).forEach(el => {
      (el.closest('ytd-rich-section-renderer') || el).setAttribute('data-ytg-hide', '1');
    });
  };

  const markShelves = (root = document) => {
    markReelShelves(root);
    // 开启整体隐藏时，下面两步标记的目标已经被 CSS 无条件隐藏了，跑了也是空转
    if (HIDE_ALL_SECTIONS) return;
    markKnownShelves(root);
    markShelvesByText(root);
  };

  // 只认标题/缩略图链接：最宽泛的 a[href*="/watch?v="] 会把合辑、播放列表卡片
  // 的内部链接也算进来，导致它们被当成普通视频卡处理
  const VIDEO_LINK_SELECTOR =
    'a.ytLockupViewModelTitle[href*="/watch?v="], ' +
    'a#video-title-link[href*="/watch?v="], ' +
    'a#thumbnail[href*="/watch?v="]';

  const getVideoId = card => {
    for (const link of card.querySelectorAll(VIDEO_LINK_SELECTOR)) {
      let url;
      try {
        url = new URL(link.href, location.origin);
      } catch {
        continue;
      }
      // 合辑 / 播放列表卡片同样指向 /watch?v=...&list=...，但它们的元数据行是
      // “频道名 · 50 个视频”这类内容，不能拿发布日期去覆盖
      if (url.searchParams.has('list')) continue;
      const videoId = url.searchParams.get('v');
      if (videoId) return videoId;
    }
    return '';
  };

  // 相对时间文案。按内容匹配而不是按“取最后一个 span”的位置匹配，这样直播
  // （“1.2万人正在观看”）、首播预告、带“新”角标的卡片都会被自然跳过。
  const RELATIVE_TIME_PATTERN = new RegExp([
    '\\d+\\s*(?:秒|分鐘|分钟|小時|小时|時間|天|日|週|周|個月|个月|か月|ヶ月|年)\\s*前',
    '\\d+\\s*(?:second|minute|hour|day|week|month|year)s?\\s+ago',
    '\\d+\\s*(?:초|분|시간|일|주|개월|년)\\s*전'
  ].join('|'), 'i');

  // 同时兼容 YouTube 当前的 ViewModel 卡片和旧版 Polymer 卡片
  const findPublishDateElement = card => {
    const candidates = [
      ...card.querySelectorAll(
        'yt-content-metadata-view-model div[role="group"] > span:not([aria-hidden="true"])'
      ),
      ...card.querySelectorAll('#metadata-line > span, #metadata-line > .inline-metadata-item')
    ];

    const relative = candidates.find(el =>
      RELATIVE_TIME_PATTERN.test(el.textContent?.trim() || '')
    );
    if (relative) return relative;

    // 已经被我们改写过的元素不再符合相对时间格式，靠备份属性找回来
    return candidates.find(el => el.hasAttribute(DATE_ORIGINAL_ATTR)) || null;
  };

  const normalizeDate = value =>
    String(value || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';

  // 先在字符串上匹配，避免把 1MB+ 的观看页 HTML 解析成 DOM
  const parsePublishDate = html => {
    const inline = html.match(/"(?:publishDate|uploadDate)"\s*:\s*"(\d{4}-\d{2}-\d{2})/)?.[1];
    if (inline) return inline;

    const metaFirst = html.match(
      /<meta[^>]+itemprop="(?:datePublished|uploadDate)"[^>]+content="(\d{4}-\d{2}-\d{2})/
    )?.[1];
    if (metaFirst) return metaFirst;

    const contentFirst = html.match(
      /<meta[^>]+content="(\d{4}-\d{2}-\d{2})[^"]*"[^>]+itemprop="(?:datePublished|uploadDate)"/
    )?.[1];
    if (contentFirst) return contentFirst;

    // 正则都没命中时才退回 DOM 解析（罕见路径）
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = doc.querySelector(
      'meta[itemprop="datePublished"], meta[itemprop="uploadDate"]'
    );
    return normalizeDate(meta?.getAttribute('content'));
  };

  // ---- 缓存：发布日期不会变，所以用 localStorage 跨标签页/会话复用 ----

  const loadCache = () => {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const parsed = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object') return;
      for (const [videoId, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value) dateCache.set(videoId, value);
      }
    } catch {
      // 缓存损坏或存储被禁用时，从空缓存开始即可
    }
  };

  const saveCache = () => {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = 0;
    try {
      localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(Object.fromEntries(dateCache)));
    } catch {
      // 配额不足或隐私模式下放弃持久化，内存缓存仍然有效
    }
  };

  const scheduleCacheSave = () => {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(saveCache, 1000);
  };

  const readCachedDate = videoId => {
    loadCache();
    return dateCache.get(videoId) || '';
  };

  const cacheDate = (videoId, value) => {
    loadCache();
    dateCache.set(videoId, value);
    // Map 按插入顺序迭代，超出上限时丢弃最早写入的条目
    for (const key of dateCache.keys()) {
      if (dateCache.size <= DATE_CACHE_LIMIT) break;
      dateCache.delete(key);
    }
    scheduleCacheSave();
  };

  // ---- 抓取：优先用 player 接口，失败再退回观看页 HTML ----

  // 从页面自身的 ytcfg 内联脚本里读出 innertube 参数
  const readInnertubeConfig = () => {
    if (innertubeConfig) return innertubeConfig;
    for (const script of document.scripts) {
      const text = script.textContent;
      if (!text || !text.includes('INNERTUBE_API_KEY')) continue;
      const key = text.match(/"INNERTUBE_API_KEY":"([\w-]+)"/)?.[1];
      const clientName = text.match(/"INNERTUBE_CLIENT_NAME":"([\w-]+)"/)?.[1];
      const clientVersion = text.match(/"INNERTUBE_CLIENT_VERSION":"([\w.-]+)"/)?.[1];
      if (key && clientVersion) {
        innertubeConfig = { key, clientName: clientName || 'WEB', clientVersion };
        return innertubeConfig;
      }
    }
    return null;
  };

  // 返回日期字符串；返回 null 表示这条通道用不了，交给观看页兜底
  const fetchViaPlayerApi = async videoId => {
    const config = readInnertubeConfig();
    if (!config) return null;

    const response = await fetch(
      `/youtubei/v1/player?key=${encodeURIComponent(config.key)}&prettyPrint=false`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          context: {
            client: { clientName: config.clientName, clientVersion: config.clientVersion }
          }
        })
      }
    );
    if (!response.ok) return null;

    const micro = (await response.json())?.microformat?.playerMicroformatRenderer;
    return normalizeDate(micro?.publishDate || micro?.uploadDate) || null;
  };

  const fetchViaWatchPage = async videoId => {
    const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsePublishDate(await response.text());
  };

  // 解析成功但确实没有日期时返回空串（确定性结果，会被缓存）；
  // 网络/HTTP 故障则抛出（临时性结果，不缓存，下次卡片再进视口时重试）
  const requestPublishDate = async videoId => {
    try {
      const date = await fetchViaPlayerApi(videoId);
      if (date) return date;
    } catch {
      // player 接口不可用（结构变更、被拦截等）时退回观看页 HTML
    }
    return fetchViaWatchPage(videoId);
  };

  const fetchPublishDate = videoId => {
    const cached = readCachedDate(videoId);
    if (cached) return Promise.resolve(cached);
    if (dateRequests.has(videoId)) return dateRequests.get(videoId);

    const request = requestPublishDate(videoId)
      .then(exactDate => {
        const value = exactDate || DATE_UNAVAILABLE;
        cacheDate(videoId, value);
        return value;
      })
      .finally(() => dateRequests.delete(videoId));

    dateRequests.set(videoId, request);
    return request;
  };

  // ---- 写回 DOM ----

  const stillMatches = (card, videoId) =>
    card.isConnected && isHome() && getVideoId(card) === videoId;

  const markUnavailable = (card, videoId) => {
    if (!stillMatches(card, videoId)) return;
    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'unavailable');
  };

  const replacePublishDate = (card, videoId, exactDate) => {
    if (!stillMatches(card, videoId)) return;
    if (!exactDate || exactDate === DATE_UNAVAILABLE) {
      markUnavailable(card, videoId);
      return;
    }

    const dateEl = findPublishDateElement(card);
    if (!dateEl) {
      markUnavailable(card, videoId);
      return;
    }

    // 卡片被回收复用后 YouTube 会把文本重新渲染成相对时间，此时刷新备份，
    // 避免 title 里留着上一个视频的“2年前”
    const currentText = dateEl.textContent.trim();
    if (RELATIVE_TIME_PATTERN.test(currentText)) {
      dateEl.setAttribute(DATE_ORIGINAL_ATTR, currentText);
    }

    dateEl.textContent = exactDate;
    dateEl.setAttribute('aria-label', exactDate);
    // 悬停仍能看到原始的相对时间，改写因此是可还原的
    const original = dateEl.getAttribute(DATE_ORIGINAL_ATTR);
    if (original) dateEl.setAttribute('title', original);

    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'done');
  };

  const runDateQueue = () => {
    while (activeDateFetches < DATE_FETCH_CONCURRENCY && dateQueue.length) {
      const { card, videoId } = dateQueue.shift();
      if (!stillMatches(card, videoId)) continue;

      activeDateFetches += 1;
      fetchPublishDate(videoId)
        .then(exactDate => replacePublishDate(card, videoId, exactDate))
        .catch(() => markUnavailable(card, videoId))
        .finally(() => {
          activeDateFetches -= 1;
          runDateQueue();
        });
    }
  };

  const queuePublishDate = card => {
    const videoId = getVideoId(card);
    if (!videoId || !findPublishDateElement(card)) return;
    const previousVideoId = card.getAttribute(DATE_VIDEO_ATTR);
    const previousStatus = card.getAttribute(DATE_STATUS_ATTR);
    if (previousVideoId === videoId &&
        (previousStatus === 'done' || previousStatus === 'queued' ||
         previousStatus === 'unavailable')) return;

    const cached = readCachedDate(videoId);
    if (cached) {
      replacePublishDate(card, videoId, cached);
      return;
    }

    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'queued');
    dateQueue.push({ card, videoId });
    runDateQueue();
  };

  // 只处理即将进入视口的卡片，避免为用户不会看到的无限滚动内容提前发请求。
  const dateObserver = new IntersectionObserver(entries => {
    if (!isHome()) return;
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      dateObserver.unobserve(entry.target);
      queuePublishDate(entry.target);
    });
  }, { rootMargin: `${DATE_PREFETCH_MARGIN} 0px` });

  const observeVideoCards = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE) return;
    const cards = new Set();
    if (root instanceof Element) {
      const containingCard = root.closest('ytd-rich-item-renderer');
      if (containingCard) cards.add(containingCard);
    }
    root.querySelectorAll?.('ytd-rich-item-renderer').forEach(card => cards.add(card));
    cards.forEach(card => {
      // 展开的 rich-shelf 内部也用 rich-item 渲染视频，这些货架内容不处理
      if (!card.closest('ytd-rich-section-renderer')) dateObserver.observe(card);
    });
  };

  // 应用一次（导航完成或初次加载时）
  const applyOnce = () => {
    injectStyle();
    if (isHome()) {
      document.documentElement.setAttribute(HOME_ATTR, '1');
      markShelves(document);
      observeVideoCards(document);
    } else {
      // 离开主页时立即移除标记，避免样式残留在其他页面（如订阅页）
      document.documentElement.removeAttribute(HOME_ATTR);
      dateObserver.disconnect();
      dateQueue.length = 0;
      document.querySelectorAll(`[${DATE_STATUS_ATTR}="queued"]`).forEach(card => {
        card.removeAttribute(DATE_STATUS_ATTR);
      });
      if (cacheSaveTimer) saveCache();
    }
  };

  // 观察动态变更（YouTube 是 SPA，不断往 #contents 塞东西）
  const mo = new MutationObserver(muts => {
    if (!isHome()) return;
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(n => {
          if (!(n instanceof Element)) return;
          markShelves(n);
          observeVideoCards(n);
        });
      }
    }
  });

  // 入口（每次导航前先断开旧的观察，避免重复注册）
  const boot = () => {
    mo.disconnect();
    applyOnce();
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };

  // 处理 SPA 导航
  window.addEventListener('yt-navigate-finish', boot);
  // 关闭/隐藏页面前把待写入的缓存落盘
  window.addEventListener('pagehide', () => {
    if (cacheSaveTimer) saveCache();
  });
  // 首次进入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
