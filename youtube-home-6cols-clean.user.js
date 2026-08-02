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

  const CARD = 'ytd-rich-item-renderer';
  const HOME = 'data-ytg-home';      // <html> 上的开关，CSS 只在主页生效
  const DONE = 'data-ytg-video';     // 卡片上记录已处理过的 videoId
  const KEEP = 'data-ytg-relative';  // 日期元素上保存原始的相对时间
  const SHOW = 'data-ytg-shown';     // 日期元素上保存我们写进去的日期

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

  const cache = new Map();   // videoId -> Promise<string>，同一次浏览只请求一次
  const results = new Map(); // videoId -> string，已返回的结果（空串表示这次取不到）

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
  // 结果同时记进 results，好让别处不必等 Promise 就知道请求有没有结束。
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
    })().then(date => {
      results.set(id, date);
      return date;
    }));
    return cache.get(id);
  };

  // 卡片上我们写的日期是否还原封不动地显示着。YouTube 可能在 videoId 不变的
  // 情况下重建日期节点，或者把它就地改成“正在直播”这类状态文字。
  const isShown = card => {
    const el = card.querySelector(`[${KEEP}]`);
    return !!el && el.textContent.trim() === el.getAttribute(SHOW);
  };

  // 这张卡片已经处理到位，既不用登记也不用再处理。
  const isSettled = (card, id) => {
    if ((card.getAttribute(DONE) || '') !== id) return false; // 换视频了
    if (!id) return true;                                     // Mix、播放列表

    const date = results.get(id);
    if (date === undefined) return true; // 请求还没回来，等它自己写回，别重复排队
    if (!date) return true;              // 这次浏览取不到日期，不重试
    return isShown(card);                // 日期还在原地就不用重做
  };

  const showDate = async card => {
    const id = videoIdOf(card);
    if (isSettled(card, id)) return;

    // 卡片换了内容就先把旧记录全部作废，包括换成 Mix、直播这类不处理的卡片：
    // 留着旧标记会让这张卡以后再显示同一个视频时被当成已处理，
    // 留着旧的还原信息则会在离开主页时覆盖新视频的文字。
    // KEEP/SHOW 只会和 DONE 一起写入、一起清除，所以没有 DONE 就没有东西要清。
    if (card.hasAttribute(DONE)) {
      card.removeAttribute(DONE); // querySelectorAll 不含 root 自身，得单独删
      clearDates(card, false);
    }
    if (!id || !dateElOf(card)) return;

    card.setAttribute(DONE, id); // 先标记，避免重复请求同一张卡
    const date = await fetchDate(id);

    // 等待期间 YouTube 可能回收并复用卡片，写回前重新确认。
    if (!date || !card.isConnected || !isHome() || videoIdOf(card) !== id) return;
    const el = dateElOf(card);
    if (!el) return;

    const relative = el.textContent.trim();
    el.setAttribute(KEEP, relative);
    el.setAttribute(SHOW, date);
    el.setAttribute('title', relative);
    el.setAttribute('aria-label', date);
    el.textContent = date;
  };

  // 清掉一棵子树上的改写记录；restore 为真时把原来的相对时间写回去。
  const clearDates = (root, restore) => {
    root.querySelectorAll(`[${KEEP}]`).forEach(el => {
      const card = el.closest(CARD);
      // 只有确认这段文字仍是我们为当前视频写进去的日期，才把相对时间还原回去。
      // 卡片换了视频、或者 YouTube 已经改写过这里，都以它写的新文字为准。
      const ours = card?.getAttribute(DONE) === videoIdOf(card) &&
        el.textContent.trim() === el.getAttribute(SHOW);
      if (restore && ours) {
        const relative = el.getAttribute(KEEP);
        el.textContent = relative;
        el.setAttribute('aria-label', relative);
      }
      el.removeAttribute('title');
      el.removeAttribute(KEEP);
      el.removeAttribute(SHOW);
    });
    root.querySelectorAll(`[${DONE}]`).forEach(card => card.removeAttribute(DONE));
  };

  // 只给进入视口的卡片取日期。
  const cardsInView = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    cardsInView.unobserve(entry.target);
    if (isHome()) showDate(entry.target);
  }));

  // 只登记发生过变化的子树，避免每次 DOM 变动都重扫整页。
  const pending = new Set();
  let queued = false;

  const flush = () => {
    queued = false;
    const roots = [...pending];
    pending.clear();
    if (!isHome()) return;

    const cards = new Set();
    for (const root of roots) {
      if (!root.isConnected) continue; // 同一帧内又被移除的子树不必登记

      // root 本身就在某张卡片里的话，它下面不可能再有别的卡片，不用往下找。
      const self = root.closest?.(CARD);
      if (self) cards.add(self);
      else root.querySelectorAll(CARD).forEach(card => cards.add(card));
    }
    cards.forEach(card => {
      // rich-section 已被隐藏，不为其中的货架视频请求日期。
      if (card.closest('ytd-rich-section-renderer')) return;
      // 已经处理到位的卡片不必再进观察队列，否则它每变化一次都要空跑一轮。
      if (!isSettled(card, videoIdOf(card))) cardsInView.observe(card);
    });
  };

  const scan = (root = document) => {
    if (!ENABLE_EXACT_PUBLISH_DATE || !isHome()) return;
    pending.add(root);
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  };

  const apply = () => {
    const root = document.documentElement;
    if (!root) return; // document-start 时 <html> 可能还没建好
    if (!style.isConnected) root.append(style);

    root.toggleAttribute(HOME, isHome());
    if (isHome()) return scan();
    cardsInView.disconnect();
    clearDates(document, true);
  };

  // 观察 document 而不是 <html>，这样脚本比文档更早执行时也能工作。
  // YouTube 复用卡片时可能只改 href 和文本节点内容，所以三种变化都要看。
  new MutationObserver(records => {
    if (!style.isConnected) apply();
    for (const record of records) {
      // 卡片被就地改写时 target 落在卡片内；新插入的整块内容走 addedNodes。
      const target = record.target;
      const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      const card = el?.closest(CARD);
      if (card) scan(card);
      record.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ['href']
  });

  window.addEventListener('yt-navigate-finish', apply);
  apply();
})();
