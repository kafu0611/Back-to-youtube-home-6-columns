// ==UserScript==
// @name         Back-to-youtube-home-6-columns
// @namespace    yt-home-6cols-clean
// @version      0.4
// @description  固定 YouTube 主页六列、隐藏插入分区，并显示视频的精确发布日期
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  // 配置
  const COLS = 6;
  const ENABLE_UNIFORM_EMPHASIS = true;
  const ENABLE_EXACT_PUBLISH_DATE = true;

  const STYLE_ID = 'yt-home-6cols-clean-style';
  const HOME_ATTR = 'data-ytg-home';
  const DATE_VIDEO_ATTR = 'data-ytg-date-video';
  const DATE_ORIGINAL_ATTR = 'data-ytg-relative-date';

  // 页面内缓存即可：同一个视频在本次浏览中只请求一次。
  const dateCache = new Map();

  const isHome = () => location.pathname === '/';

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
:root[${HOME_ATTR}="1"] ytd-rich-grid-renderer {
  --ytd-rich-grid-items-per-row: ${COLS} !important;
}

:root[${HOME_ATTR}="1"] ytd-rich-item-renderer {
  max-width: none !important;
  transform: none !important;
  zoom: 1 !important;
}

${ENABLE_UNIFORM_EMPHASIS ? `
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[is-emphasized],
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer[lockup] {
  contain: content;
}
` : ''}

:root[${HOME_ATTR}="1"] ytd-reel-shelf-renderer,
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer:has(ytd-reel-shelf-renderer),
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer {
  display: none !important;
}
`;
    document.documentElement.appendChild(style);
  };

  // 只认普通视频的标题链接；Mix/播放列表链接带有 list 参数，直接跳过。
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

  // 按相对时间文本找元素，不依赖它在元数据行中的位置。
  const isRelativeTime = text => {
    const value = text?.replace(/\u00a0/g, ' ').trim() || '';
    return /\d[\s\S]*(?:\bago|前|\s전|назад|geleden|siden|sedan|önce|trước|yang lalu|fa)$/i.test(value) ||
      /^(?:just now|刚刚|剛剛)$/i.test(value);
  };

  const findDateElement = card => Array.from(card.querySelectorAll(
    'yt-content-metadata-view-model span[role="text"], ' +
    '#metadata-line > span, #metadata-line > .inline-metadata-item'
  )).find(el =>
    isRelativeTime(el.textContent) ||
    isRelativeTime(el.getAttribute('aria-label'))
  ) || null;

  const fetchPublishDate = videoId => {
    if (dateCache.has(videoId)) return dateCache.get(videoId);

    const request = (async () => {
      try {
        const ytcfg = globalThis.ytcfg;
        const apiKey = ytcfg?.get?.('INNERTUBE_API_KEY');
        const context = ytcfg?.get?.('INNERTUBE_CONTEXT');
        if (!apiKey || !context) return '';

        const response = await fetch(
          `/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, videoId })
          }
        );
        if (!response.ok) return '';

        const data = await response.json();
        const microformat = data?.microformat?.playerMicroformatRenderer;
        const value = microformat?.publishDate || microformat?.uploadDate || '';
        return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
      } catch {
        return '';
      }
    })();

    dateCache.set(videoId, request);
    return request;
  };

  const replacePublishDate = async card => {
    const videoId = getVideoId(card);
    const dateEl = videoId ? findDateElement(card) : null;
    if (!videoId || !dateEl) return;
    if (card.getAttribute(DATE_VIDEO_ATTR) === videoId) return;

    // 先标记，避免同一个动态卡片被 MutationObserver 重复处理。
    card.setAttribute(DATE_VIDEO_ATTR, videoId);
    const exactDate = await fetchPublishDate(videoId);

    // 等待期间 YouTube 可能回收并复用卡片，写回前重新确认。
    if (!exactDate || !card.isConnected || !isHome() ||
        getVideoId(card) !== videoId) return;

    const currentDateEl = findDateElement(card);
    if (!currentDateEl) return;

    const relativeDate = currentDateEl.textContent.trim();
    currentDateEl.setAttribute(DATE_ORIGINAL_ATTR, relativeDate);
    currentDateEl.textContent = exactDate;
    currentDateEl.setAttribute('aria-label', exactDate);
    currentDateEl.setAttribute('title', relativeDate);
  };

  const dateObserver = new IntersectionObserver(entries => {
    if (!isHome()) return;
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      dateObserver.unobserve(entry.target);
      replacePublishDate(entry.target);
    });
  });

  const observeCards = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE) return;

    const cards = new Set();
    if (root instanceof Element) {
      const card = root.closest('ytd-rich-item-renderer');
      if (card) cards.add(card);
    }
    root.querySelectorAll?.('ytd-rich-item-renderer').forEach(card => cards.add(card));

    cards.forEach(card => {
      // rich-section 已被隐藏，不为其中的货架视频请求日期。
      if (!card.closest('ytd-rich-section-renderer')) dateObserver.observe(card);
    });
  };

  const restoreDates = () => {
    document.querySelectorAll(`[${DATE_ORIGINAL_ATTR}]`).forEach(el => {
      const original = el.getAttribute(DATE_ORIGINAL_ATTR);
      if (original) {
        el.textContent = original;
        el.setAttribute('aria-label', original);
      }
      el.removeAttribute(DATE_ORIGINAL_ATTR);
      el.removeAttribute('title');
    });
    document.querySelectorAll(`[${DATE_VIDEO_ATTR}]`).forEach(card => {
      card.removeAttribute(DATE_VIDEO_ATTR);
    });
  };

  const apply = () => {
    injectStyle();
    if (isHome()) {
      document.documentElement.setAttribute(HOME_ATTR, '1');
      observeCards(document);
    } else {
      document.documentElement.removeAttribute(HOME_ATTR);
      dateObserver.disconnect();
      restoreDates();
    }
  };

  const mutationObserver = new MutationObserver(mutations => {
    if (!isHome()) return;
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node instanceof Element) observeCards(node);
      });
    });
  });

  const boot = () => {
    mutationObserver.disconnect();
    apply();
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  window.addEventListener('yt-navigate-finish', boot);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
