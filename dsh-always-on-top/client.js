/**
 * Client half of dsh-always-on-top.
 *
 * One square button in the frame-wide overlay layer, sitting just left of the
 * Windows caption buttons (minimize / maximize / close) in the title bar. The
 * caption buttons themselves belong to the OS (titleBarOverlay), so the only
 * place a project control can live is that reserved strip's left neighbour.
 *
 * The click goes to the Host half over the plugin's own web route; the Host
 * flips WS_EX_TOPMOST with Win32 SetWindowPos.
 */
window.__ModuleLoader__.load({
  id: 'dsh-always-on-top',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-always-on-top';
    const STYLE_ID = 'dsh-always-on-top';
    // The pin must read as a fourth caption button: same cell width/height as the
    // native minimize/maximize/close cells, flush against them, no radius, the
    // same neutral hover wash and the same thin glyph weight. The caption strip
    // geometry comes from the Window Controls Overlay env vars; the fallbacks
    // (46px cell, 40px strip) only apply when the shell does not publish them.
    const CSS = [
      '.dsh-aot-pin{position:fixed;top:0;',
      'right:calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,calc(100vw - 138px)));',
      'z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'width:46px;height:env(titlebar-area-height,40px);padding:0;margin:0;box-sizing:border-box;',
      'border:0;border-radius:0;background:transparent;',
      'color:var(--dsw-alias-label-secondary,rgba(70,70,70,.9));',
      'cursor:default;pointer-events:auto;-webkit-app-region:no-drag;',
      'transition:background-color 100ms linear,color 100ms linear;outline:none}',
      '.dsh-aot-pin:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#000) 8%,transparent);',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-aot-pin:active{background:color-mix(in srgb,var(--dsw-alias-label-primary,#000) 14%,transparent)}',
      '.dsh-aot-pin[data-on="true"]{color:var(--dsw-alias-brand-primary,#2f6fed)}',
      '.dsh-aot-pin[data-on="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fed) 12%,transparent)}',
      '.dsh-aot-pin:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#2f6fed)}',
      '.dsh-aot-pin[data-busy="true"]{opacity:.5}',
      '.dsh-aot-pin[data-off="true"]{display:none}',
      '.dsh-aot-pin svg{width:13px;height:13px;display:block;pointer-events:none}',
    ].join('');

    function usePinStyles() {
      React.useEffect(() => {
        const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
        if (existing) {
          // A re-evaluated module must not keep stale rules around.
          if (existing.textContent !== CSS) existing.textContent = CSS;
          return undefined;
        }
        const tag = document.createElement('style');
        tag.dataset.plugin = STYLE_ID;
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, []);
    }

    async function request(pathname, init) {
      const response = await fetch(ROUTE + pathname, Object.assign({
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }, init));
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return body || { ok: false, topmost: false, reason: 'bad-response' };
    }

    function PinIcon({ on }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        fill: on ? 'currentColor' : 'none',
        fillOpacity: on ? 0.22 : 0,
        stroke: 'currentColor',
        strokeWidth: 1.9,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5-1.5l1.5-4l4-4' }),
        h('path', { d: 'M9 15l-4.5 4.5' }),
        h('path', { d: 'M14.5 4l-2.5-2.5' }));
    }

    function PinButton() {
      usePinStyles();
      const [on, setOn] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [hidden, setHidden] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        let attempt = 0;
        let timer = null;
        const read = () => {
          request('/status', { method: 'GET' })
            .then((body) => {
              if (!alive) return;
              if (body && body.reason === 'unsupported-platform') {
                setHidden(true);
                return;
              }
              if (body && typeof body.topmost === 'boolean') {
                setOn(body.topmost);
                if (body.ok) return;
              }
              // The desktop window may not exist yet on a cold start.
              attempt += 1;
              if (attempt < 4) timer = setTimeout(read, 1500);
            })
            .catch(() => { /* keep the default unpinned look */ });
        };
        read();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, []);

      const onClick = React.useCallback(() => {
        if (busy) return;
        setBusy(true);
        request('/toggle', { method: 'POST' })
          .then((body) => {
            if (body && typeof body.topmost === 'boolean') setOn(body.topmost);
          })
          .catch(() => { /* the next status read reconciles */ })
          .finally(() => setBusy(false));
      }, [busy]);

      const label = on ? '取消置顶窗口' : '窗口置顶（始终保持在最顶层）';
      return h('button', {
        type: 'button',
        className: 'dsh-aot-pin',
        title: label,
        'aria-label': label,
        'aria-pressed': on,
        'data-on': on ? 'true' : 'false',
        'data-busy': busy ? 'true' : 'false',
        'data-off': hidden ? 'true' : 'false',
        onClick,
      }, h(PinIcon, { on }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-always-on-top.pin',
          order: 40,
          label: '窗口置顶',
        }, PinButton));
      },
    };
  },
});
