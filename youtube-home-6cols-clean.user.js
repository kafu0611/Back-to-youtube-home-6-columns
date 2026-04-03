// ==UserScript==
// @name         Back-to-youtube-home-6-columns
// @namespace    yt-home-6cols-clean
// @version      0.2
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  // 配置
  const COLS = 6;                 // 主页每行视频个数
  const ENABLE_UNIFORM_EMPHASIS = true; // 把“强调/超大卡片”也压回普通宽度（更整齐）

  const STYLE_ID = 'yt-home-6cols-clean-style';

  // 只在主页生效（YouTube 主页路径仅为 '/'）
  const isHome = () => location.pathname === '/';

  // 注入 CSS（只改变量，不改 display）
  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
/* 固定主页 6 列（覆盖内部断点逻辑） */
ytd-rich-grid-renderer {
  --ytd-rich-grid-items-per-row: ${COLS} !important;
}

/* 让卡片不要被内部 max-width/缩放约束住 */
ytd-rich-item-renderer {
  max-width: none !important;
  transform: none !important;
  zoom: 1 !important;
}

/* 可选：把”强调/超大卡片”恢复为普通卡（避免一行只剩它一个） */
${ENABLE_UNIFORM_EMPHASIS ? `
ytd-rich-item-renderer[is-emphasized],
ytd-rich-item-renderer[lockup] {
  contain: content;
}
` : ''}

/* 立即隐藏已知的货架组件（CSS 能直接命中的先处理） */
/* Shorts 行 */
ytd-reel-shelf-renderer,
ytd-rich-item-renderer:has(ytd-reel-shelf-renderer),
ytd-rich-section-renderer:has(ytd-reel-shelf-renderer) {
  display: none !important;
}
/* 全部 rich-shelf（例如“按主题推荐/分类货架”等） */
ytd-rich-shelf-renderer,
ytd-rich-section-renderer:has(#rich-shelf-header-container) {
  display: none !important;
}

/* JS 标记的目标统一隐藏 */
[data-ytg-hide="1"] { display: none !important; }
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
  };

  // 应用一次（导航完成或初次加载时）
  const applyOnce = () => {
    if (!isHome()) return;
    injectStyle();
    markKnownShelves(document);
    markShelvesByText(document);
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
