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
  const ENABLE_EXACT_PUBLISH_DATE = true;
  const DATE_FETCH_CONCURRENCY = 3; // 限制同时请求数，避免滚动时集中请求

  const STYLE_ID = 'yt-home-6cols-clean-style';
  const HOME_ATTR = 'data-ytg-home';
  const DATE_STATUS_ATTR = 'data-ytg-date-status';
  const DATE_VIDEO_ATTR = 'data-ytg-date-video';
  const DATE_CACHE_PREFIX = 'ytg-publish-date:';

  const dateCache = new Map();
  const dateRequests = new Map();
  const dateQueue = [];
  let activeDateFetches = 0;

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
/* 主页网格里真正的视频卡片（ytd-rich-item-renderer）永远是 ytd-rich-grid-renderer
   的直接子项，不会被包在 ytd-rich-section-renderer 里；反过来，只要内容被包在
   ytd-rich-section-renderer 里，就一定是货架/问卷/推广等“插入型”内容（Shorts 行、
   分类货架 rich-shelf、chips-shelf-with-video-shelf、inline-survey 反馈问卷、
   “重大新闻”等）。直接按容器类型整体隐藏，不用再为 YouTube 新增的每种货架组件
   逐一维护选择器 */
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer {
  display: none !important;
}

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

  // Shorts、rich-shelf 的 JS 兜底（如果后来动态插入）
  const markKnownShelves = (root = document) => {
    root.querySelectorAll('ytd-reel-shelf-renderer').forEach(el => {
      (el.closest('ytd-rich-section-renderer') ||
       el.closest('ytd-rich-item-renderer') || el).setAttribute('data-ytg-hide', '1');
    });
    root.querySelectorAll('ytd-rich-shelf-renderer').forEach(el => {
      (el.closest('ytd-rich-section-renderer') || el).setAttribute('data-ytg-hide', '1');
    });
    root.querySelectorAll('ytd-chips-shelf-with-video-shelf-renderer').forEach(el => {
      (el.closest('ytd-rich-section-renderer') || el).setAttribute('data-ytg-hide', '1');
    });
  };

  const getVideoId = card => {
    const link = card.querySelector(
      'a.ytLockupViewModelTitle[href*="/watch?v="], ' +
      'a#video-title-link[href*="/watch?v="], ' +
      'a#thumbnail[href*="/watch?v="], ' +
      'a[href*="/watch?v="]'
    );
    if (!link) return '';
    try {
      return new URL(link.href, location.origin).searchParams.get('v') || '';
    } catch {
      return '';
    }
  };

  // 同时兼容 YouTube 当前的 ViewModel 卡片和旧版 Polymer 卡片。
  // 只有“观看次数 • 模糊日期”这种至少有两个字段的行才会被修改，直播卡片不会误改。
  const findPublishDateElement = card => {
    const metadataModels = card.querySelectorAll('yt-content-metadata-view-model');
    for (const model of metadataModels) {
      const rows = model.querySelectorAll(':scope > div[role="group"]');
      for (const row of rows) {
        const parts = Array.from(row.children).filter(el =>
          el.matches('span:not([aria-hidden="true"])') &&
          el.textContent?.trim()
        );
        if (parts.length >= 2) return parts[parts.length - 1];
      }
    }

    const legacyParts = card.querySelectorAll(
      '#metadata-line > span, #metadata-line > .inline-metadata-item'
    );
    return legacyParts.length >= 2 ? legacyParts[legacyParts.length - 1] : null;
  };

  const parsePublishDate = html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = doc.querySelector(
      'meta[itemprop="datePublished"], meta[itemprop="uploadDate"]'
    );
    const metaDate = meta?.getAttribute('content')?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (metaDate) return metaDate;

    // 当 YouTube 未输出 meta 标签时，从播放器 microformat 数据兜底。
    const match = html.match(/"(?:publishDate|uploadDate)"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || '';
  };

  const readCachedDate = videoId => {
    if (dateCache.has(videoId)) return dateCache.get(videoId);
    try {
      const value = sessionStorage.getItem(`${DATE_CACHE_PREFIX}${videoId}`) || '';
      if (value) dateCache.set(videoId, value);
      return value;
    } catch {
      return '';
    }
  };

  const cacheDate = (videoId, value) => {
    dateCache.set(videoId, value);
    try {
      sessionStorage.setItem(`${DATE_CACHE_PREFIX}${videoId}`, value);
    } catch {
      // 浏览器禁用存储或达到配额时，保留当前页面内的内存缓存即可。
    }
  };

  const fetchPublishDate = videoId => {
    const cached = readCachedDate(videoId);
    if (cached) return Promise.resolve(cached);
    if (dateRequests.has(videoId)) return dateRequests.get(videoId);

    const request = fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: 'same-origin'
    }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const exactDate = parsePublishDate(await response.text());
      if (exactDate) cacheDate(videoId, exactDate);
      return exactDate;
    }).finally(() => dateRequests.delete(videoId));

    dateRequests.set(videoId, request);
    return request;
  };

  const replacePublishDate = (card, videoId, exactDate) => {
    if (!card.isConnected || !isHome() || getVideoId(card) !== videoId) return;
    const dateEl = findPublishDateElement(card);
    if (!dateEl || !exactDate) {
      card.setAttribute(DATE_STATUS_ATTR, 'unavailable');
      return;
    }

    if (!dateEl.hasAttribute('data-ytg-relative-date')) {
      dateEl.setAttribute('data-ytg-relative-date', dateEl.textContent.trim());
    }
    dateEl.textContent = exactDate;
    dateEl.setAttribute('aria-label', exactDate);
    dateEl.setAttribute('title', exactDate);
    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'done');
  };

  const runDateQueue = () => {
    while (activeDateFetches < DATE_FETCH_CONCURRENCY && dateQueue.length) {
      const { card, videoId } = dateQueue.shift();
      if (!card.isConnected || !isHome() || getVideoId(card) !== videoId) continue;

      activeDateFetches += 1;
      fetchPublishDate(videoId)
        .then(exactDate => replacePublishDate(card, videoId, exactDate))
        .catch(() => card.isConnected && isHome() && getVideoId(card) === videoId &&
          card.setAttribute(DATE_STATUS_ATTR, 'unavailable'))
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
  }, { rootMargin: '800px 0px' });

  const observeVideoCards = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE) return;
    const cards = new Set();
    if (root instanceof Element) {
      const containingCard = root.closest('ytd-rich-item-renderer');
      if (containingCard) cards.add(containingCard);
    }
    root.querySelectorAll?.('ytd-rich-item-renderer').forEach(card => cards.add(card));
    cards.forEach(card => {
      if (!card.closest('ytd-rich-section-renderer')) dateObserver.observe(card);
    });
  };

  // 应用一次（导航完成或初次加载时）
  const applyOnce = () => {
    injectStyle();
    if (isHome()) {
      document.documentElement.setAttribute(HOME_ATTR, '1');
      markKnownShelves(document);
      markShelvesByText(document);
      observeVideoCards(document);
    } else {
      // 离开主页时立即移除标记，避免样式残留在其他页面（如订阅页）
      document.documentElement.removeAttribute(HOME_ATTR);
      dateObserver.disconnect();
      dateQueue.length = 0;
      document.querySelectorAll(`[${DATE_STATUS_ATTR}="queued"]`).forEach(card => {
        card.removeAttribute(DATE_STATUS_ATTR);
      });
    }
  };

  // 观察动态变更（YouTube 是 SPA，不断往 #contents 塞东西）
  const mo = new MutationObserver(muts => {
    if (!isHome()) return;
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(n => {
          if (!(n instanceof Element)) return;
          markKnownShelves(n);
          markShelvesByText(n);
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
  // 首次进入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
