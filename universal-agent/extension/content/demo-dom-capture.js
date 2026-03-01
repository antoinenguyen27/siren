(function initDemoDomCapture() {
  if (window.__UA_DEMO_DOM_CAPTURE__) return;

  const state = {
    active: false,
    sessionStartMs: 0,
    events: [],
    listenersAttached: false,
    mutationObserver: null,
    mutationCountSinceLastEvent: 0,
    frameUrl: location.href,
  };

  function nowMs() {
    return Date.now();
  }

  function normalizeText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 180);
  }

  function safeAttr(node, name) {
    if (!node || !node.getAttribute) return '';
    return normalizeText(node.getAttribute(name) || '');
  }

  function summarizeNode(node) {
    if (!(node instanceof Element)) return null;
    const tag = String(node.tagName || '').toLowerCase();
    const id = normalizeText(node.id || '');
    const role = safeAttr(node, 'role');
    const name = normalizeText(node.getAttribute?.('name') || '');
    const type = normalizeText(node.getAttribute?.('type') || '');
    const ariaLabel = safeAttr(node, 'aria-label');
    const title = normalizeText(node.getAttribute?.('title') || '');
    const dataTestId =
      safeAttr(node, 'data-testid') ||
      safeAttr(node, 'data-test') ||
      safeAttr(node, 'data-qa') ||
      safeAttr(node, 'data-cy');
    const text = normalizeText(node.innerText || node.textContent || '');
    const classes = Array.from(node.classList || []).slice(0, 4);
    return {
      tag,
      id,
      role,
      name,
      type,
      ariaLabel,
      title,
      dataTestId,
      classes,
      text,
    };
  }

  function cssPath(node) {
    if (!(node instanceof Element)) return '';
    const parts = [];
    let current = node;
    let depth = 0;
    while (current && depth < 6) {
      const tag = String(current.tagName || '').toLowerCase();
      if (!tag) break;
      let part = tag;
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
      if (classes.length > 0) {
        part += `.${classes.join('.')}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((el) => el.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current);
          if (idx >= 0) part += `:nth-of-type(${idx + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(' > ').slice(0, 400);
  }

  function ancestry(node, maxLevels = 4) {
    const levels = [];
    let current = node instanceof Element ? node : null;
    for (let i = 0; i < maxLevels && current; i += 1) {
      levels.push(summarizeNode(current));
      current = current.parentElement;
    }
    return levels.filter(Boolean);
  }

  function isSensitiveInput(el) {
    if (!(el instanceof Element)) return false;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    return type === 'password';
  }

  function pushEvent(kind, target, extra = {}) {
    if (!state.active) return;
    const ts = nowMs();
    const targetSummary = summarizeNode(target);
    const event = {
      kind,
      ts,
      tOffsetMs: Math.max(0, ts - state.sessionStartMs),
      frameUrl: state.frameUrl,
      target: targetSummary,
      selectors: {
        css: cssPath(target),
      },
      ancestry: ancestry(target, 4),
      mutationCountSinceLastEvent: state.mutationCountSinceLastEvent,
      ...extra,
    };
    state.events.push(event);
    state.mutationCountSinceLastEvent = 0;
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    pushEvent('click', target, {
      button: event.button,
    });
  }

  function onInput(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (isSensitiveInput(target)) return;
    const value =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? normalizeText(target.value)
        : '';
    pushEvent('input', target, value ? { valuePreview: value.slice(0, 80) } : {});
  }

  function onChange(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (isSensitiveInput(target)) return;
    let value = '';
    if (target instanceof HTMLSelectElement) {
      value = normalizeText(target.value || target.selectedOptions?.[0]?.text || '');
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      value = normalizeText(target.value);
    }
    pushEvent('change', target, value ? { valuePreview: value.slice(0, 80) } : {});
  }

  function onSubmit(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    pushEvent('submit', target);
  }

  function attachListeners() {
    if (state.listenersAttached) return;
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
    state.listenersAttached = true;
  }

  function detachListeners() {
    if (!state.listenersAttached) return;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    state.listenersAttached = false;
  }

  function startMutationObserver() {
    if (state.mutationObserver) return;
    state.mutationObserver = new MutationObserver((mutations) => {
      if (!state.active) return;
      state.mutationCountSinceLastEvent += Array.isArray(mutations) ? mutations.length : 0;
    });
    state.mutationObserver.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  }

  function stopMutationObserver() {
    if (!state.mutationObserver) return;
    state.mutationObserver.disconnect();
    state.mutationObserver = null;
  }

  function start(sessionStartMs) {
    state.sessionStartMs = Number(sessionStartMs) || nowMs();
    state.events = [];
    state.mutationCountSinceLastEvent = 0;
    state.frameUrl = location.href;
    state.active = true;
    attachListeners();
    startMutationObserver();
    return { ok: true, frameUrl: state.frameUrl };
  }

  function stop() {
    state.active = false;
    detachListeners();
    stopMutationObserver();
    return {
      ok: true,
      frameUrl: state.frameUrl,
      events: state.events.slice(0, 300),
      dropped: Math.max(0, state.events.length - 300),
    };
  }

  window.__UA_DEMO_DOM_CAPTURE__ = {
    start,
    stop,
  };
})();
