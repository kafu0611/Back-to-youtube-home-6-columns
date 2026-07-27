// ==UserScript==
// @name         Back-to-youtube-home-6-columns
// @namespace    yt-home-6cols-clean
// @version      0.3.1
// @description  固定 YouTube 主页六列、隐藏插入货架，并显示视频的精确发布日期
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  // 配置
  const COLS = 6;                 // 主页每行视频个数
  const ENABLE_UNIFORM_EMPHASIS = true; // 把“强调/超大卡片”也压回普通宽度（更整齐）
  const ENABLE_EXACT_PUBLISH_DATE = true;
  const HIDE_ALL_SECTIONS = true; // false 时保留“继续观看”等普通分区，只隐藏已知货架
  const DATE_FETCH_CONCURRENCY = 3;
  const DATE_CACHE_LIMIT = 500;
  const DATE_MAX_RETRIES = 2;

  const STYLE_ID = 'yt-home-6cols-clean-style';
  const HOME_ATTR = 'data-ytg-home';
  const DATE_STATUS_ATTR = 'data-ytg-date-status';
  const DATE_VIDEO_ATTR = 'data-ytg-date-video';
  const DATE_RETRY_ATTR = 'data-ytg-date-retries';
  const DATE_CACHE_KEY = 'ytg-publish-date-cache-v1';
  const DATE_CACHE_MISS = '-';

  const loadDateCache = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || '{}');
      return new Map(Object.entries(parsed).slice(-DATE_CACHE_LIMIT));
    } catch {
      return new Map();
    }
  };

  const dateCache = loadDateCache();
  const dateRequests = new Map();
  const dateQueue = [];
  let activeDateFetches = 0;
  let innertubeConfig = null;

  // 只在主页生效（YouTube 主页路径仅为 '/'）
  const isHome = () => location.pathname === '/';

  // 注入 CSS。所有规则都限定在主页属性下，离开主页后立即失效。
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

/* 可选：把“强调/超大卡片”恢复为普通卡 */
${ENABLE_UNIFORM_EMPHASIS ? `
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[is-emphasized],
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[lockup] {
  contain: content;
}
` : ''}

/* Shorts 行有时在 rich-section 内，有时直接嵌在 rich-item 内。 */
:root[${HOME_ATTR}="1"] ytd-reel-shelf-renderer,
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer:has(ytd-reel-shelf-renderer) {
  display: none !important;
}

${HIDE_ALL_SECTIONS ? `
/* 按用户配置隐藏主页全部插入型分区；其中可能包含“继续观看”等普通分区。 */
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer {
  display: none !important;
}
` : `
/* 保留普通分区，仅隐藏已知 Shorts/分类货架。 */
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer:has(ytd-reel-shelf-renderer),
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer:has(ytd-rich-shelf-renderer),
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer:has(ytd-chips-shelf-with-video-shelf-renderer) {
  display: none !important;
}
`}
`;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.documentElement.appendChild(s);
  };

  // 只认标题链接，并排除 Mix/播放列表，避免把“50 个视频”等文案当成日期。
  const getVideoId = card => {
    const link = card.querySelector(
      'a.ytLockupMetadataViewModelTitle[href*="/watch?v="], ' +
      'a.ytLockupViewModelTitle[href*="/watch?v="], ' +
      'a#video-title-link[href*="/watch?v="], ' +
      'a#video-title[href*="/watch?v="]'
    );
    if (!link) return '';
    try {
      const url = new URL(link.href, location.origin);
      if (url.searchParams.has('list')) return '';
      const videoId = url.searchParams.get('v') || '';
      return /^[\w-]{11}$/.test(videoId) ? videoId : '';
    } catch {
      return '';
    }
  };

  // YouTube 的多语言相对时间。按内容查找，不依赖字段顺序或“最后一个 span”。
  const relativeTimePatterns = [
    /\bago$/i,
    /前$/,
    /\s전$/,
    /назад$/i,
    /geleden$/i,
    /siden$/i,
    /sedan$/i,
    /önce$/i,
    /trước$/i,
    /yang lalu$/i,
    /(?:^|\s)fa$/i,
    /^(?:vor|il y a|hace|há)\s+/i,
    /ที่แล้ว$/i,
    /^قبل\s+/i,
    /^(?:just now|moments? ago|刚刚|剛剛)$/i
  ];

  const isRelativeTimeText = value => {
    const text = value?.replace(/\u00a0/g, ' ').trim() || '';
    return text !== '' && relativeTimePatterns.some(pattern => pattern.test(text));
  };

  const findPublishDateElement = card => {
    const candidates = card.querySelectorAll(
      'yt-content-metadata-view-model span[role="text"], ' +
      '#metadata-line > span, #metadata-line > .inline-metadata-item'
    );
    return Array.from(candidates).find(el =>
      isRelativeTimeText(el.textContent) ||
      isRelativeTimeText(el.getAttribute('aria-label'))
    ) || null;
  };

  const extractConfigValue = (text, key) => {
    const match = text.match(
      new RegExp(`"${key}"\\s*:\\s*(?:"([^"]*)"|([^,}\\s]+))`)
    );
    return match?.[1] || match?.[2] || '';
  };

  // @grant none 让脚本能直接读取页面 ytcfg；脚本标签解析用于配置对象尚未暴露时兜底。
  const getInnertubeConfig = () => {
    if (innertubeConfig) return innertubeConfig;

    const pageConfig = globalThis.ytcfg;
    const apiKey = pageConfig?.get?.('INNERTUBE_API_KEY') || '';
    const context = pageConfig?.get?.('INNERTUBE_CONTEXT');
    const clientVersion = pageConfig?.get?.('INNERTUBE_CLIENT_VERSION') ||
      context?.client?.clientVersion || '';
    if (apiKey && context && clientVersion) {
      innertubeConfig = {
        apiKey,
        context: JSON.parse(JSON.stringify(context)),
        clientNameHeader: String(
          pageConfig?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME') || '1'
        ),
        clientVersion
      };
      return innertubeConfig;
    }

    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('INNERTUBE_API_KEY')) continue;

      const scriptApiKey = extractConfigValue(text, 'INNERTUBE_API_KEY');
      const scriptClientVersion = extractConfigValue(text, 'INNERTUBE_CLIENT_VERSION');
      if (!scriptApiKey || !scriptClientVersion) continue;

      innertubeConfig = {
        apiKey: scriptApiKey,
        context: {
          client: {
            clientName: extractConfigValue(text, 'INNERTUBE_CLIENT_NAME') || 'WEB',
            clientVersion: scriptClientVersion,
            hl: extractConfigValue(text, 'HL') || document.documentElement.lang || 'en',
            gl: extractConfigValue(text, 'GL') || 'US'
          }
        },
        clientNameHeader:
          extractConfigValue(text, 'INNERTUBE_CONTEXT_CLIENT_NAME') || '1',
        clientVersion: scriptClientVersion
      };
      return innertubeConfig;
    }

    return null;
  };

  const persistDateCache = () => {
    while (dateCache.size > DATE_CACHE_LIMIT) {
      dateCache.delete(dateCache.keys().next().value);
    }
    try {
      localStorage.setItem(
        DATE_CACHE_KEY,
        JSON.stringify(Object.fromEntries(dateCache))
      );
    } catch {
      // 浏览器禁用存储或达到配额时，保留当前页面内的内存缓存即可。
    }
  };

  // undefined 表示尚未请求；空字符串表示已确认没有可显示日期。
  const readCachedDate = videoId => {
    if (!dateCache.has(videoId)) return undefined;
    const value = dateCache.get(videoId);
    return value === DATE_CACHE_MISS ? '' : value;
  };

  const cacheDate = (videoId, value) => {
    dateCache.delete(videoId);
    dateCache.set(videoId, value || DATE_CACHE_MISS);
    persistDateCache();
  };

  const fetchPublishDate = videoId => {
    const cached = readCachedDate(videoId);
    if (cached !== undefined) return Promise.resolve(cached);
    if (dateRequests.has(videoId)) return dateRequests.get(videoId);

    const config = getInnertubeConfig();
    if (!config) return Promise.reject(new Error('Innertube config unavailable'));

    const request = fetch(
      `/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': config.clientNameHeader,
          'X-YouTube-Client-Version': config.clientVersion
        },
        body: JSON.stringify({
          context: config.context,
          videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      }
    ).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const microformat = data?.microformat?.playerMicroformatRenderer;
      const exactDate = microformat?.publishDate || microformat?.uploadDate || '';
      cacheDate(videoId, exactDate);
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

    const relativeDate = dateEl.textContent.trim();
    dateEl.setAttribute('data-ytg-relative-date', relativeDate);
    dateEl.textContent = exactDate;
    dateEl.setAttribute('aria-label', exactDate);
    dateEl.setAttribute('title', `${exactDate}（原显示：${relativeDate}）`);
    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'done');
    card.removeAttribute(DATE_RETRY_ATTR);
  };

  const markDateUnavailable = (card, videoId) => {
    if (!card.isConnected || !isHome() || getVideoId(card) !== videoId) return;
    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'unavailable');
    card.removeAttribute(DATE_RETRY_ATTR);
  };

  const retryPublishDate = (card, videoId) => {
    if (!card.isConnected || !isHome() || getVideoId(card) !== videoId) return;
    const retries = Number(card.getAttribute(DATE_RETRY_ATTR) || '0') + 1;
    if (retries > DATE_MAX_RETRIES) {
      markDateUnavailable(card, videoId);
      return;
    }

    card.setAttribute(DATE_RETRY_ATTR, String(retries));
    card.removeAttribute(DATE_STATUS_ATTR);
    setTimeout(() => {
      if (card.isConnected && isHome() && getVideoId(card) === videoId) {
        dateObserver.observe(card);
      }
    }, retries * 1000);
  };

  const runDateQueue = () => {
    while (activeDateFetches < DATE_FETCH_CONCURRENCY && dateQueue.length) {
      const { card, videoId } = dateQueue.shift();
      if (!card.isConnected || !isHome() || getVideoId(card) !== videoId) continue;

      activeDateFetches += 1;
      fetchPublishDate(videoId)
        .then(exactDate => {
          if (exactDate) replacePublishDate(card, videoId, exactDate);
          else markDateUnavailable(card, videoId);
        })
        .catch(() => retryPublishDate(card, videoId))
        .finally(() => {
          activeDateFetches -= 1;
          runDateQueue();
        });
    }
  };

  const queuePublishDate = card => {
    const videoId = getVideoId(card);
    const dateEl = videoId ? findPublishDateElement(card) : null;
    if (!videoId || !dateEl) return;

    const previousVideoId = card.getAttribute(DATE_VIDEO_ATTR);
    const previousStatus = card.getAttribute(DATE_STATUS_ATTR);
    if (previousVideoId === videoId &&
        (previousStatus === 'done' || previousStatus === 'queued' ||
         previousStatus === 'unavailable')) return;

    const cached = readCachedDate(videoId);
    if (cached !== undefined) {
      if (cached) replacePublishDate(card, videoId, cached);
      else markDateUnavailable(card, videoId);
      return;
    }

    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    card.setAttribute(DATE_STATUS_ATTR, 'queued');
    dateQueue.push({ card, videoId });
    runDateQueue();
  };

  // 仅在卡片真正进入视口时获取日期，快速滚过的内容不会提前请求。
  const dateObserver = new IntersectionObserver(entries => {
    if (!isHome()) return;
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      dateObserver.unobserve(entry.target);
      queuePublishDate(entry.target);
    });
  }, { rootMargin: '0px' });

  const observeVideoCards = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE) return;
    const cards = new Set();
    if (root instanceof Element) {
      const containingCard = root.closest('ytd-rich-item-renderer');
      if (containingCard) cards.add(containingCard);
    }
    root.querySelectorAll?.('ytd-rich-item-renderer').forEach(card => cards.add(card));
    cards.forEach(card => {
      if (!HIDE_ALL_SECTIONS || !card.closest('ytd-rich-section-renderer')) {
        dateObserver.observe(card);
      }
    });
  };

  const restoreRelativeDates = () => {
    document.querySelectorAll('[data-ytg-relative-date]').forEach(el => {
      const original = el.getAttribute('data-ytg-relative-date');
      if (original) {
        el.textContent = original;
        el.setAttribute('aria-label', original);
      }
      el.removeAttribute('data-ytg-relative-date');
      el.removeAttribute('title');
    });
    document.querySelectorAll(`[${DATE_VIDEO_ATTR}]`).forEach(card => {
      card.removeAttribute(DATE_VIDEO_ATTR);
      card.removeAttribute(DATE_STATUS_ATTR);
      card.removeAttribute(DATE_RETRY_ATTR);
    });
  };

  // 应用一次（导航完成或初次加载时）
  const applyOnce = () => {
    injectStyle();
    if (isHome()) {
      document.documentElement.setAttribute(HOME_ATTR, '1');
      observeVideoCards(document);
    } else {
      document.documentElement.removeAttribute(HOME_ATTR);
      dateObserver.disconnect();
      dateQueue.length = 0;
      restoreRelativeDates();
      document.querySelectorAll(`[${DATE_STATUS_ATTR}="queued"]`).forEach(card => {
        card.removeAttribute(DATE_STATUS_ATTR);
      });
    }
  };

  // 观察动态变更（YouTube 是 SPA，不断往 #contents 塞东西）
  const mo = new MutationObserver(muts => {
    if (!isHome()) return;
    for (const m of muts) {
      if (!m.addedNodes?.length) continue;
      m.addedNodes.forEach(n => {
        if (n instanceof Element) observeVideoCards(n);
      });
    }
  });

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
