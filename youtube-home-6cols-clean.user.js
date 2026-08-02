// ==UserScript==
// @name         Back-to-youtube-home-6-columns
// @namespace    yt-home-6cols-clean
// @version      0.5
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

  const HOME = 'data-ytg-home';      // <html> 上的开关，CSS 只在主页生效
  const DONE = 'data-ytg-video';     // 卡片上记录已处理过的 videoId
  const KEEP = 'data-ytg-relative';  // 日期元素上保存原始的相对时间

  const isHome = () => location.pathname === '/';

  // 样式在 <html> 一出现就挂上，避免先闪一次默认列数。
  const style = document.createElement('style');
  style.textContent = `
:root[${HOME}] ytd-rich-grid-renderer {
  --ytd-rich-grid-items-per-row: ${COLS} !important;
}
:root[${HOME}] ytd-rich-item-renderer {
  max-width: none !important;
  transform: none !important;
  zoom: 1 !important;
}
:root[${HOME}] ytd-reel-shelf-renderer,
:root[${HOME}] ytd-rich-item-renderer:has(ytd-reel-shelf-renderer),
:root[${HOME}] ytd-rich-section-renderer {
  display: none !important;
}
${ENABLE_UNIFORM_EMPHASIS ? `:root[${HOME}] ytd-rich-item-renderer[is-emphasized],
:root[${HOME}] ytd-rich-item-renderer[lockup] {
  contain: content;
}` : ''}
`;

  // ---- 精确发布日期 ----

  const cache = new Map(); // videoId -> Promise<string>，同一次浏览只请求一次

  // 卡片内第一个 /watch 链接就是这张卡的视频；Mix/播放列表带 list 参数，跳过。
  const videoIdOf = card => {
    const link = card.querySelector('a[href*="/watch?v="]');
    if (!link) return '';
    const url = new URL(link.href, location.origin);
    const id = url.searchParams.has('list') ? '' : url.searchParams.get('v');
    return /^[\w-]{11}$/.test(id) ? id : '';
  };

  // 按文本判断相对时间，不依赖它在元数据行中的位置。
  const RELATIVE =
    /\d[\s\S]*(?:\bago|前|\s전|назад|geleden|siden|sedan|önce|trước|yang lalu|fa)$|^(?:just now|刚刚|剛剛)$/i;
  const looksRelative = text => RELATIVE.test((text || '').replace(/\u00a0/g, ' ').trim());

  const dateElOf = card => [...card.querySelectorAll(
    'yt-content-metadata-view-model span[role="text"], ' +
    '#metadata-line > span, #metadata-line > .inline-metadata-item'
  )].find(el => looksRelative(el.textContent) || looksRelative(el.getAttribute('aria-label')));

  // 复用页面自带的 Innertube 接口，不需要 API key，也不下载完整观看页。
  const fetchDate = id => {
    if (!cache.has(id)) cache.set(id, (async () => {
      try {
        const key = globalThis.ytcfg?.get?.('INNERTUBE_API_KEY');
        const context = globalThis.ytcfg?.get?.('INNERTUBE_CONTEXT');
        if (!key || !context) return '';

        const res = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context, videoId: id })
        });
        const micro = (await res.json())?.microformat?.playerMicroformatRenderer;
        const value = micro?.publishDate || micro?.uploadDate || '';
        return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
      } catch {
        return '';
      }
    })());
    return cache.get(id);
  };

  const showDate = async card => {
    const id = videoIdOf(card);
    if (!id || card.getAttribute(DONE) === id || !dateElOf(card)) return;

    card.setAttribute(DONE, id); // 先标记，避免重复请求同一张卡
    const date = await fetchDate(id);

    // 等待期间 YouTube 可能回收并复用卡片，写回前重新确认。
    if (!date || !card.isConnected || !isHome() || videoIdOf(card) !== id) return;
    const el = dateElOf(card);
    if (!el) return;

    const relative = el.textContent.trim();
    el.setAttribute(KEEP, relative);
    el.setAttribute('title', relative);
    el.setAttribute('aria-label', date);
    el.textContent = date;
  };

  const restoreDates = () => {
    document.querySelectorAll(`[${KEEP}]`).forEach(el => {
      const relative = el.getAttribute(KEEP);
      el.textContent = relative;
      el.setAttribute('aria-label', relative);
      el.removeAttribute('title');
      el.removeAttribute(KEEP);
    });
    document.querySelectorAll(`[${DONE}]`).forEach(card => card.removeAttribute(DONE));
  };

  // 只给进入视口的卡片取日期；observe 可重复调用，被回收复用的卡片会重新排队。
  const cardsInView = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    cardsInView.unobserve(entry.target);
    if (isHome()) showDate(entry.target);
  }));

  let scanQueued = false;
  const scan = () => {
    if (scanQueued || !ENABLE_EXACT_PUBLISH_DATE || !isHome()) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      if (!isHome()) return;
      // rich-section 已被隐藏，不为其中的货架视频请求日期。
      document.querySelectorAll('ytd-rich-item-renderer:not(ytd-rich-section-renderer *)')
        .forEach(card => cardsInView.observe(card));
    });
  };

  const apply = () => {
    const root = document.documentElement;
    if (!root) return; // document-start 时 <html> 可能还没建好
    if (!style.isConnected) root.append(style);

    root.toggleAttribute(HOME, isHome());
    if (isHome()) return scan();
    cardsInView.disconnect();
    restoreDates();
  };

  // 观察 document 而不是 <html>，这样脚本比文档更早执行时也能工作。
  new MutationObserver(() => {
    if (!style.isConnected) apply();
    scan();
  }).observe(document, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', apply);
  apply();
})();
