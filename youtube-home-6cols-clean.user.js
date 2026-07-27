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
  const DATE_CONCURRENCY = 3;     // 限制同时请求数，避免滚动时集中请求

  const STYLE_ID = 'yt-home-6cols-clean-style';
  const HOME_ATTR = 'data-ytg-home';
  const DATE_ATTR = 'data-ytg-date-for';        // 值是已处理（或处理中）的 videoId
  const ORIGINAL_ATTR = 'data-ytg-relative-date';
  const CACHE_PREFIX = 'ytg-date:';
  const NO_DATE = '-';            // 查过、但确实没有发布日期

  // 只在主页生效（YouTube 主页路径仅为 '/'）
  const isHome = () => location.pathname === '/';

  // 注入 CSS（只改变量，不改 display）
  // 规则统一限定在 :root[data-ytg-home="1"] 下，避免离开主页后样式残留在
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

/* Shorts 行有时不包在 rich-section 里，而是直接嵌在 rich-item 里 */
:root[${HOME_ATTR}="1"] ytd-reel-shelf-renderer,
:root[${HOME_ATTR}="1"] ytd-rich-item-renderer:has(ytd-reel-shelf-renderer) {
  display: none !important;
}

/* 主页网格里的推荐视频卡片是 ytd-rich-grid-renderer 的直接子项；被 rich-section
   包起来的都是“插入型”内容（分类货架、问卷、“重大新闻”等），整体隐藏即可，
   不用为 YouTube 新增的每种货架维护选择器。
   注意 rich-shelf 展开后内部同样用 rich-item 渲染视频，所以“rich-item 一定不在
   rich-section 里”并不成立——observeCards 里的 closest() 正是为了排除它们。 */
:root[${HOME_ATTR}="1"] ytd-rich-section-renderer {
  display: none !important;
}
`;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.documentElement.appendChild(s);
  };

  // ---- 精确发布日期 ----

  // 只认标题/缩略图链接：宽泛的 a[href*="/watch?v="] 会把卡片内的其他链接也算进来
  const VIDEO_LINK = 'a.ytLockupViewModelTitle[href*="/watch?v="], ' +
    'a#video-title-link[href*="/watch?v="], a#thumbnail[href*="/watch?v="]';

  const getVideoId = card => {
    for (const a of card.querySelectorAll(VIDEO_LINK)) {
      const url = new URL(a.href, location.origin);
      // 合辑/播放列表卡片也指向 /watch?v=...&list=...，但它的元数据是“50 个视频”
      if (!url.searchParams.has('list')) return url.searchParams.get('v') || '';
    }
    return '';
  };

  // 按文案找相对时间，而不是按“取最后一个 span”的位置找：这样直播（“1.2万人正在观看”）、
  // 首播预告、带“新”角标的卡片都会自然跳过，也不依赖元数据字段的顺序。
  const RELATIVE = /\d+\s*(?:秒|分鐘|分钟|小时|小時|時間|天|日|周|週|个月|個月|年)\s*前|\d+\s+\w+\s+ago|\d+\s*(?:초|분|시간|일|주|개월|년)\s*전/;

  // 同时兼容当前的 ViewModel 卡片和旧版 Polymer 卡片
  const findDateEl = card => [...card.querySelectorAll(
    'yt-content-metadata-view-model div[role="group"] > span:not([aria-hidden="true"]), ' +
    '#metadata-line > span, #metadata-line > .inline-metadata-item'
  )].find(el => RELATIVE.test(el.textContent) || el.hasAttribute(ORIGINAL_ATTR)) || null;

  // 发布日期不会变，直接用 localStorage 跨标签页/会话复用
  const readCache = id => {
    try { return localStorage.getItem(CACHE_PREFIX + id) || ''; } catch { return ''; }
  };
  const writeCache = (id, value) => {
    try { localStorage.setItem(CACHE_PREFIX + id, value); } catch { /* 隐私模式/配额 */ }
  };

  // 从页面自身的 ytcfg 里取 innertube 参数，只解析一次
  let innertube;
  const getInnertube = () => {
    if (innertube !== undefined) return innertube;
    innertube = null;
    for (const s of document.scripts) {
      const text = s.textContent;
      if (!text.includes('INNERTUBE_API_KEY')) continue;
      const key = text.match(/"INNERTUBE_API_KEY":"([\w-]+)"/)?.[1];
      const version = text.match(/"INNERTUBE_CLIENT_VERSION":"([\w.-]+)"/)?.[1];
      if (key && version) { innertube = { key, version }; break; }
    }
    return innertube;
  };

  // 用 YouTube 自己的 player 接口：返回的是小体积 JSON，而不是 1MB+ 的观看页 HTML。
  // 拿不到就返回空串，卡片保持原样的相对时间——功能退化，但不会出错。
  const fetchDate = async videoId => {
    const cfg = getInnertube();
    if (!cfg) return '';
    const res = await fetch(`/youtubei/v1/player?key=${cfg.key}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: cfg.version } }
      })
    });
    if (!res.ok) throw new Error(res.status);
    const micro = (await res.json())?.microformat?.playerMicroformatRenderer;
    return String(micro?.publishDate || micro?.uploadDate || '')
      .match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
  };

  const applyDate = (card, videoId, date) => {
    // 卡片被回收复用、或已经离开主页时，清掉标记让它以后能重新处理
    if (!isHome() || !card.isConnected || getVideoId(card) !== videoId) {
      card.removeAttribute(DATE_ATTR);
      return;
    }
    const el = findDateEl(card);
    if (!el) return;

    // 复用后的卡片会被重新渲染成相对时间，这时刷新备份，避免 title 里留着上一个视频的
    const text = el.textContent.trim();
    if (RELATIVE.test(text)) el.setAttribute(ORIGINAL_ATTR, text);

    el.textContent = date;
    el.title = el.getAttribute(ORIGINAL_ATTR) || ''; // 悬停仍能看到原始的“2年前”
    el.setAttribute('aria-label', date);
  };

  const queue = [];
  let active = 0;

  const pump = () => {
    while (active < DATE_CONCURRENCY && queue.length) {
      const { card, videoId } = queue.shift();
      if (!card.isConnected || getVideoId(card) !== videoId) continue;

      active += 1;
      fetchDate(videoId)
        .then(date => {
          writeCache(videoId, date || NO_DATE);
          if (date) applyDate(card, videoId, date);
        })
        // 请求失败不写缓存，也清掉标记，下次再遇到这个视频时重新请求
        .catch(() => card.removeAttribute(DATE_ATTR))
        .finally(() => { active -= 1; pump(); });
    }
  };

  const handleCard = card => {
    const videoId = getVideoId(card);
    if (!videoId || card.getAttribute(DATE_ATTR) === videoId || !findDateEl(card)) return;
    card.setAttribute(DATE_ATTR, videoId);

    const cached = readCache(videoId);
    if (cached === NO_DATE) return;
    if (cached) return applyDate(card, videoId, cached);

    queue.push({ card, videoId });
    pump();
  };

  // 只处理接近视口的卡片，不为用户未必看到的无限滚动内容提前发请求
  const io = new IntersectionObserver(entries => {
    if (!isHome()) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      handleCard(entry.target);
    }
  }, { rootMargin: '200px 0px' });

  const observeCards = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE) return;
    const cards = new Set(root.querySelectorAll?.('ytd-rich-item-renderer') || []);
    if (root instanceof Element) {
      const own = root.closest('ytd-rich-item-renderer');
      if (own) cards.add(own);
    }
    // 展开的货架内部也用 rich-item 渲染视频，这些不处理
    cards.forEach(card => {
      if (!card.closest('ytd-rich-section-renderer')) io.observe(card);
    });
  };

  // 应用一次（导航完成或初次加载时）
  const applyOnce = () => {
    injectStyle();
    if (isHome()) {
      document.documentElement.setAttribute(HOME_ATTR, '1');
      observeCards(document);
    } else {
      // 离开主页时立即移除标记，避免样式残留在其他页面（如订阅页）
      document.documentElement.removeAttribute(HOME_ATTR);
      io.disconnect();
      queue.splice(0).forEach(({ card }) => card.removeAttribute(DATE_ATTR));
    }
  };

  // 观察动态变更（YouTube 是 SPA，不断往 #contents 塞东西）
  const mo = new MutationObserver(muts => {
    if (!isHome()) return;
    for (const m of muts) {
      for (const n of m.addedNodes) if (n instanceof Element) observeCards(n);
    }
  });

  // 入口（每次导航前先断开旧的观察，避免重复注册）
  const boot = () => {
    mo.disconnect();
    applyOnce();
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };

  window.addEventListener('yt-navigate-finish', boot);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
