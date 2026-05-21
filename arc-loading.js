/* Shared arc loading overlay — uses parent full-page overlay when embedded in index.html */

(function (global) {

  const ARC_LOADING_MIN_MS = 1500;

  const ARC_LOADING_PAINT_MS = 15;

  let arcLoadingDepth = 0;

  let parentLoadingActive = false;



  function arcLoadingPaintBuffer() {

    return new Promise((resolve) => setTimeout(resolve, ARC_LOADING_PAINT_MS));

  }

  let stylesInjected = false;



  const OVERLAY_SVG =

    '<svg class="arc-loading-overlay__logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">' +

    '<rect x="29" y="29" width="6" height="6"></rect>' +

    '<line x1="32" y1="29" x2="32" y2="10"></line><line x1="32" y1="10" x2="38" y2="10"></line>' +

    '<line x1="32" y1="35" x2="32" y2="54"></line><line x1="32" y1="54" x2="26" y2="54"></line>' +

    '<line x1="35" y1="32" x2="54" y2="32"></line><line x1="54" y1="32" x2="54" y2="26"></line>' +

    '<line x1="29" y1="32" x2="10" y2="32"></line><line x1="10" y1="32" x2="10" y2="38"></line>' +

    '<line x1="35" y1="29" x2="46" y2="18"></line><line x1="46" y1="18" x2="46" y2="14"></line>' +

    '<line x1="29" y1="35" x2="18" y2="46"></line><line x1="18" y1="46" x2="18" y2="50"></line>' +

    '<line x1="35" y1="35" x2="46" y2="46"></line><line x1="46" y1="46" x2="50" y2="46"></line>' +

    '<line x1="29" y1="29" x2="18" y2="18"></line><line x1="18" y1="18" x2="14" y2="18"></line>' +

    '</svg>';



  function isEmbedded() {

    try {

      return global.parent !== global;

    } catch (_) {

      return false;

    }

  }



  function notifyParent(phase) {

    try {

      global.parent.postMessage({ type: 'arctium-arc-loading', phase }, '*');

    } catch (_) {}

  }



  function parentLoadingApi() {

    try {

      const p = global.parent;

      if (!p || p === global) return null;

      if (typeof p.showArcLoading === 'function' && typeof p.hideArcLoading === 'function') {

        return p;

      }

    } catch (_) {}

    return null;

  }



  function showParentLoading() {

    const p = parentLoadingApi();

    if (p) {

      p.showArcLoading();

      parentLoadingActive = true;

      return true;

    }

    notifyParent('start');

    parentLoadingActive = false;

    return false;

  }



  function hideParentLoading() {

    if (parentLoadingActive) {

      try {

        parentLoadingApi()?.hideArcLoading();

      } catch (_) {}

      parentLoadingActive = false;

      return;

    }

    notifyParent('end');

  }



  function injectStyles() {

    if (stylesInjected) return;

    stylesInjected = true;

    const style = document.createElement('style');

    style.textContent =

      'body.arc-loading{overflow:hidden}' +

      'body.arc-loading::before{content:"";position:fixed;inset:0;z-index:29999;' +

      'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:rgba(13,15,14,0.55);pointer-events:all}' +

      '.arc-loading-overlay{position:fixed;inset:0;z-index:30000;display:flex;align-items:center;justify-content:center;' +

      'background:transparent;pointer-events:none}' +

      '.arc-loading-overlay[hidden]{display:none!important}' +

      '@keyframes arc-loading-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +

      '.arc-loading-overlay__logo{width:72px;height:72px;color:var(--text,#e8ede8);display:block;' +

      'transform-origin:center center;animation:arc-loading-spin 1.5s steps(12) infinite;pointer-events:none}';

    document.head.appendChild(style);

  }



  function ensureOverlay() {

    injectStyles();

    let overlay = document.getElementById('arcLoadingOverlay');

    if (overlay) return overlay;

    overlay = document.createElement('div');

    overlay.id = 'arcLoadingOverlay';

    overlay.className = 'arc-loading-overlay';

    overlay.hidden = true;

    overlay.setAttribute('aria-hidden', 'true');

    overlay.innerHTML = OVERLAY_SVG;

    document.body.appendChild(overlay);

    return overlay;

  }



  function showArcLoading() {

    arcLoadingDepth++;

    const overlay = ensureOverlay();

    overlay.hidden = false;

    overlay.setAttribute('aria-hidden', 'false');

    document.body.classList.add('arc-loading');

    document.body.setAttribute('aria-busy', 'true');

  }



  function hideArcLoading() {

    arcLoadingDepth = Math.max(0, arcLoadingDepth - 1);

    if (arcLoadingDepth > 0) return;

    const overlay = document.getElementById('arcLoadingOverlay');

    if (overlay) {

      overlay.hidden = true;

      overlay.setAttribute('aria-hidden', 'true');

    }

    document.body.classList.remove('arc-loading');

    document.body.removeAttribute('aria-busy');

  }



  async function withArcLoadingLocal(task) {

    showArcLoading();

    await arcLoadingPaintBuffer();

    const started = performance.now();

    try {

      return await task();

    } finally {

      const delay = Math.max(0, ARC_LOADING_MIN_MS - (performance.now() - started));

      await new Promise((resolve) => setTimeout(resolve, delay));

      hideArcLoading();

    }

  }



  async function withArcLoadingEmbedded(task) {

    showParentLoading();

    await arcLoadingPaintBuffer();

    const started = performance.now();

    try {

      return await task();

    } finally {

      const delay = Math.max(0, ARC_LOADING_MIN_MS - (performance.now() - started));

      await new Promise((resolve) => setTimeout(resolve, delay));

      hideParentLoading();

    }

  }



  async function withArcLoading(task) {

    if (isEmbedded()) {

      return withArcLoadingEmbedded(task);

    }

    return withArcLoadingLocal(task);

  }



  /* Always register — bunkers-standalone-shared used to define a local-only loader first */
  global.showArcLoading = showArcLoading;
  global.hideArcLoading = hideArcLoading;
  global.withArcLoading = withArcLoading;

})(typeof window !== 'undefined' ? window : globalThis);


