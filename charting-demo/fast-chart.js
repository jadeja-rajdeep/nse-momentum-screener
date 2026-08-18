/*!
 * fast-chart.js  v1.0.0
 * A lightweight, dependency-free, canvas-based candlestick/indicator chart engine.
 * MIT-style: use it anywhere, no build step, single <script> include.
 *
 * ---------------------------------------------------------------------------
 * WHY / DESIGN
 * ---------------------------------------------------------------------------
 *  - One canvas layer for "base" content (candles/volume/MAs/lines/markers),
 *    redrawn only when data or the visible range change.
 *  - One tiny "overlay" canvas layer for crosshair + live drawing preview,
 *    redrawn every animation frame while the pointer moves — never touches
 *    the base layer, so hovering is cheap even on big datasets.
 *  - Multiple charts (a main candle chart + N indicator panes below it, like
 *    TradingView's RSI/MACD sub-panes) can be linked into a FastChart.Group:
 *    panning/zooming/crosshair on any one of them mirrors to all the others.
 *  - Horizontal lines / trendlines / boxes are added programmatically only
 *    (chart.addLine / chart.addOverlay) — there is no mouse-driven drawing
 *    tool. That keeps the event surface small and the engine predictable:
 *    every line on the chart came from your code, never from stray clicks.
 *  - Fully theme-able (bg, text, grid, candle up/down, volume, crosshair,
 *    panel colors, font) via chart.setTheme({...}) or FastChart.themes.*.
 *  - Non-interactive `compact` mode (opts.interactive:false) skips all
 *    pointer/resize event binding and the crosshair/legend entirely — for
 *    thumbnail charts in cards/lists where you just want a fast static (or
 *    pan/zoom-only) render.
 *  - No dependencies, no build step, ~1 file. Everything is namespaced under
 *    the single global `FastChart`.
 *
 * ---------------------------------------------------------------------------
 * USAGE (script tag, no bundler needed)
 * ---------------------------------------------------------------------------
 *   <script src="fast-chart.js"></script>
 *   <script>
 *     const chart = new FastChart.Chart(document.getElementById('main'), {
 *       bars: [{d:'2024-01-01', o:100, h:105, l:98, c:103, v:120000}, ...],
 *       ma: [{period:50, type:'sma', color:'#2563eb'}],
 *     });
 *
 *     const rsiPane = new FastChart.IndicatorPane(document.getElementById('rsi'), {
 *       series: [{ name:'RSI', color:'#7c3aed', values: rsiValues }],
 *       bars: chart.bars,          // needs the same date axis
 *       height: 120,
 *       bands: [{y:70,color:'#94a3b8'},{y:30,color:'#94a3b8'}]
 *     });
 *
 *     FastChart.Group.link([chart, rsiPane]);   // synced crosshair + zoom/pan
 *
 *     chart.addMarkers([{date:'2024-03-11', text:'B', position:'below', color:'#1a8a4a'}]);
 *     chart.addLine({ type: 'trendline', p1:{i:10,price:100}, p2:{i:60,price:130}, extendRight:true });
 *     chart.setTheme(FastChart.themes.dark);
 *
 *     // fast static thumbnail for a card/list — no axes, no crosshair, no
 *     // event listeners bound at all:
 *     new FastChart.Chart(document.getElementById('thumb'), {
 *       bars, compact: true, interactive: false, legend: false, height: 120
 *     });
 *   </script>
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  // ======================================================================
  // Small shared utilities
  // ======================================================================
  const DPR = () => Math.max(1, Math.min(3, global.devicePixelRatio || 1));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const uid = (() => { let n = 0; return (p) => (p || "id") + "_" + (++n); })();

  function deepMerge(base, extra) {
    const out = Object.assign({}, base);
    for (const k in (extra || {})) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k]) && base[k] && typeof base[k] === "object") {
        out[k] = deepMerge(base[k], extra[k]);
      } else {
        out[k] = extra[k];
      }
    }
    return out;
  }

  function fmtVol(v) {
    v = v || 0;
    return v >= 1e7 ? (v / 1e7).toFixed(1) + "Cr" :
           v >= 1e5 ? (v / 1e5).toFixed(1) + "L" :
           v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v);
  }
  function fmtPrice(v) {
    if (v == null || isNaN(v)) return "-";
    return v >= 100 ? Math.round(v).toLocaleString("en-IN") : v.toFixed(2);
  }
  function fmtDateShort(d) {
    return `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
  }
  function fmtDateFull(d) {
    return `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} '${d.slice(2, 4)}`;
  }

  // ---- moving averages (no deps) ----
  function sma(cs, n) {
    const o = new Array(cs.length).fill(null);
    let s = 0;
    for (let i = 0; i < cs.length; i++) { s += cs[i]; if (i >= n) s -= cs[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function ema(cs, n) {
    const o = new Array(cs.length).fill(null), k = 2 / (n + 1);
    let e = null;
    for (let i = 0; i < cs.length; i++) { e = e == null ? cs[i] : cs[i] * k + e * (1 - k); if (i >= n - 1) o[i] = e; }
    return o;
  }

  // ======================================================================
  // Default themes — every visual color lives here. setTheme() deep-merges
  // a partial object on top of whichever theme is active.
  // ======================================================================
  const themes = {
    light: {
      bg: "#ffffff",
      text: "#5b6470",
      grid: "#f1f3f5",
      gridFine: "#f6f7f8",
      up: "#1a8a4a",
      down: "#d2392f",
      volUp: "rgba(26,138,74,0.35)",
      volDown: "rgba(210,57,47,0.35)",
      crosshair: "#9aa3ad",
      panel: "#334155",
      panelText: "#ffffff",
      border: "#eef0f2",
      font: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"
    },
    dark: {
      bg: "#0e1117",
      text: "#8b93a1",
      grid: "#1b2028",
      gridFine: "#171b22",
      up: "#26a65b",
      down: "#e5484d",
      volUp: "rgba(38,166,91,0.35)",
      volDown: "rgba(229,72,77,0.35)",
      crosshair: "#5b6472",
      panel: "#2a2f3a",
      panelText: "#ffffff",
      border: "#1f242d",
      font: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"
    }
  };

  // ======================================================================
  // Base class shared by Chart (candles) and IndicatorPane (line/hist panes)
  // Handles: canvas setup, resize, pan/zoom input, crosshair loop, marker
  // rendering, theme, and Group linking. Subclasses only need to implement
  // `_computeScales()` and `_drawBase(ctx, S)`.
  // ======================================================================
  class BasePane {
    constructor(container, opts) {
      this.el = container;
      this.opts = Object.assign({ height: 300, theme: themes.light, interactive: true }, opts || {});
      if (typeof this.opts.theme === "string") this.opts.theme = themes[this.opts.theme] || themes.light;
      this.theme = deepMerge(themes.light, this.opts.theme);
      this.bars = opts.bars || [];
      this.markers = (opts.markers || []).slice();
      this.drawings = (opts.drawings || []).slice();     // set only via addLine()/opts.drawings — code-driven, never by mouse
      this.overlays = (opts.overlays || []).slice();     // custom (ctx,S,pane)=>void draw fns — boxes, custom glyphs, etc.
      this._view = { a: 0, b: this.bars.length };
      this._raf = null;
      this._group = null;              // FastChart.Group this pane belongs to
      this._buildDom();
      if (this.opts.interactive !== false) this._bindEvents();
      this._bindResize();
      // NOTE: subclasses must call this.resize() themselves at the end of
      // their own constructor, once any subclass-specific fields used by
      // _computeScales()/_drawBase() (e.g. Chart's _maSeries, IndicatorPane's
      // series/bands) have been assigned. Calling it here would render
      // before those fields exist.
    }

    // ------------------------------------------------------------ DOM ---
    _buildDom() {
      const wrap = document.createElement("div");
      wrap.className = "fc-wrap";
      wrap.style.cssText = "position:relative;width:100%;user-select:none;touch-action:none;overflow:hidden;";
      wrap.style.height = (this.opts.height || 300) + "px";
      wrap.style.background = this.theme.bg;

      this.base = document.createElement("canvas");
      this.base.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;";
      wrap.appendChild(this.base);

      // The overlay (crosshair) canvas + its event listeners only exist in
      // interactive mode — a non-interactive/compact thumbnail chart skips
      // both entirely, so it's a single static canvas with zero listeners.
      if (this.opts.interactive !== false) {
        this.overlay = document.createElement("canvas");
        this.overlay.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;cursor:crosshair;";
        this.overlay.style.zIndex = "1";
        wrap.appendChild(this.overlay);
      }

      // Built-in TradingView-style legend box (top-left), used when caller
      // doesn't supply their own readoutEl. Skipped for compact/thumbnail
      // charts by default (opts.legend defaults to !compact).
      const wantLegend = this.opts.legend != null ? this.opts.legend : !this.opts.compact;
      if (wantLegend) {
        this.legendEl = document.createElement("div");
        this.legendEl.className = "fc-legend";
        this.legendEl.style.cssText = "position:absolute;left:8px;top:6px;z-index:5;font:11px " +
          this.theme.font + ";pointer-events:none;line-height:1.5;white-space:nowrap;";
        wrap.appendChild(this.legendEl);
      }

      this.el.appendChild(wrap);
      this.wrap = wrap;
      this.bctx = this.base.getContext("2d");
      this.octx = this.overlay ? this.overlay.getContext("2d") : null;
    }

    // -------------------------------------------------------- sizing ----
    resize() {
      const rect = this.wrap.getBoundingClientRect();
      const w = Math.max(40, Math.round(rect.width));
      const h = Math.max(40, Math.round(rect.height));
      const dpr = DPR();
      if (this._cssW === w && this._cssH === h && this._dpr === dpr) { this._layout(); this.render(); return; }
      this._cssW = w; this._cssH = h; this._dpr = dpr;
      const canvases = this.overlay ? [this.base, this.overlay] : [this.base];
      canvases.forEach(c => { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); });
      this.bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.octx) this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._layout();
      this.render();
    }

    _layout() {
      const compact = !!this.opts.compact, W = this._cssW, H = this._cssH;
      const padT = compact ? 6 : 10, padB = compact ? 14 : 22;
      const pl = compact ? 4 : 8, pr = compact ? 6 : 56;
      this.L = { W, H, padT, padB, pl, pr, yTop: padT, yBot: H - padB };
    }

    // ----------------------------------------------------------- data ---
    setData(bars) {
      this.bars = bars || [];
      this._view = { a: 0, b: this.bars.length };
      this.render();
    }
    setTheme(partial) {
      this.theme = deepMerge(this.theme, partial || {});
      this.wrap.style.background = this.theme.bg;
      this.render();
    }
    setOptions(opts) { Object.assign(this.opts, opts || {}); this.render(); }

    // -------------------------------------------------------- markers ---
    addMarkers(list) { this.markers = this.markers.concat(list || []); this.render(); return this; }
    clearMarkers() { this.markers = []; this.render(); return this; }

    // ------------------------------------------------------- overlays ---
    // Custom draw functions: fn(ctx, S, pane) called after markers/drawings
    // on every render. Used for base/consolidation boxes, custom glyphs,
    // or any bespoke drawing that doesn't fit the built-in vocabulary.
    addOverlay(fn) { this.overlays.push(fn); this.render(); return this; }
    clearOverlays() { this.overlays = []; this.render(); }

    // ------------------------------------------------------- drawings ---
    // Code-only API for horizontal lines / trendlines / boxes — there is no
    // mouse-driven drawing tool. This is the ONLY way lines get onto the
    // chart, which keeps rendering deterministic and the event surface small.
    //   Horizontal:  chart.addLine({ type:'horizontal', y:123.4, label:'pivot', color:'#1a8a4a' })
    //   Trendline:   chart.addLine({ type:'trendline', p1:{i:10,price:100}, p2:{i:60,price:130}, extendRight:true })
    //   Box:         chart.addLine({ type:'box', p1:{i:10,price:100}, p2:{i:40,price:120}, label:'base' })
    // p1/p2 use `i` = absolute bar index into `this.bars`, `price` = y-value.
    addLine(cfg) {
      const d = Object.assign({ id: uid("line"), color: this.theme.up, width: 1.4 }, cfg);
      this.drawings.push(d);
      this.render();
      return d.id;
    }
    removeLine(id) { this.drawings = this.drawings.filter(d => d.id !== id); this.render(); }
    clearLines() { this.drawings = []; this.render(); }

    // ------------------------------------------------------- zoom/pan ---
    zoomTo(a, b, fromGroup) {
      const n = this.bars.length;
      a = clamp(Math.round(a), 0, n - 1); b = clamp(Math.round(b), a + 5, n);
      this._view = { a, b };
      this.render();
      if (this._group && !fromGroup) this._group._broadcastView(this, a, b);
    }
    resetZoom() { this.zoomTo(0, this.bars.length); }

    // ----------------------------------------------------------- misc ---
    destroy() {
      if (this._ro) this._ro.disconnect();
      if (this._group) this._group.remove(this);
      this.wrap.remove();
    }

    // subclasses implement:
    _computeScales() { throw new Error("not implemented"); }
    _drawBase(ctx, S) { throw new Error("not implemented"); }
    legendHtml(bar, i) { return ""; }

    // -------------------------------------------------------- render ---
    render() {
      const ctx = this.bctx, L = this.L, th = this.theme;
      ctx.clearRect(0, 0, L.W, L.H);
      ctx.fillStyle = th.bg;
      ctx.fillRect(0, 0, L.W, L.H);
      if (!this.bars.length) return;
      const S = this._computeScales();
      this._S = S;
      this._drawGrid(ctx, S);
      this._drawBase(ctx, S);
      this._drawMarkers(ctx, S);
      this._drawDrawings(ctx, S);
      this.overlays.forEach(fn => { try { fn(ctx, S, this); } catch (e) { /* one bad overlay shouldn't kill the chart */ } });
      if (this.legendEl && !this._lastLocal) {
        const last = this.bars.length - 1;
        this.legendEl.innerHTML = this.legendHtml(this.bars[last], last);
      }
    }

    _drawGrid(ctx, S) {
      const L = this.L, th = this.theme, plotW = L.W - L.pl - L.pr;
      const maxL = Math.max(3, Math.floor(plotW / 78));
      const step = Math.max(1, Math.ceil(S.n / maxL));
      ctx.font = "10.5px " + th.font;
      ctx.fillStyle = th.text; ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      let lastX = -1e9;
      if (!this.opts.compact) {
        for (let i = 0; i < S.n; i += step) {
          const bar = S.vis[i], xx = S.x(i);
          if (xx - lastX < 40) continue; lastX = xx;
          ctx.beginPath(); ctx.moveTo(xx, L.yTop); ctx.lineTo(xx, L.yBot); ctx.stroke();
          if (this.opts.showDateAxis !== false) {
            const label = fmtDateShort(bar.d);
            const anc = xx < L.pl + 24 ? "left" : xx > L.W - L.pr - 24 ? "right" : "center";
            ctx.textAlign = anc === "center" ? "center" : anc === "left" ? "start" : "end";
            ctx.fillText(label, xx, L.H - 7);
          }
        }
      }
      if (!this.opts.compact && S.yTicks) {
        S.yTicks.forEach(t => {
          const yy = S.y(t.v);
          ctx.strokeStyle = th.gridFine;
          ctx.beginPath(); ctx.moveTo(L.pl, yy); ctx.lineTo(L.W - L.pr, yy); ctx.stroke();
          ctx.fillStyle = th.text; ctx.textAlign = "left";
          ctx.fillText(t.label, L.W - L.pr + 4, yy + 3);
        });
      }
    }

    // markers rendered above/below the bar's high/low
    _drawMarkers(ctx, S) {
      (this.markers || []).forEach(m => {
        const gi = this.bars.findIndex(b => b.d === m.date);
        if (gi < 0) return;
        const i = gi - S.a; if (i < 0 || i >= S.n) return;
        const bar = S.vis[i];
        const above = m.position !== "below";
        const refV = above ? (bar.h != null ? bar.h : bar.v0) : (bar.l != null ? bar.l : bar.v0);
        const yy = S.y(refV) + (above ? -9 : 9);
        const xx = S.x(i);
        const col = m.color || "#b8860b";
        ctx.save();
        ctx.fillStyle = col; ctx.strokeStyle = col; ctx.textAlign = "center";
        const shape = m.shape || (m.text ? "text" : "arrow");
        if (shape === "arrow") {
          ctx.beginPath();
          if (above) { ctx.moveTo(xx, yy + 5); ctx.lineTo(xx - 5, yy - 3); ctx.lineTo(xx + 5, yy - 3); }
          else { ctx.moveTo(xx, yy - 5); ctx.lineTo(xx - 5, yy + 3); ctx.lineTo(xx + 5, yy + 3); }
          ctx.closePath(); ctx.fill();
        } else if (shape === "circle") {
          ctx.beginPath(); ctx.arc(xx, yy, 4, 0, Math.PI * 2); ctx.fill();
        } else if (shape === "square") {
          ctx.fillRect(xx - 4, yy - 4, 8, 8);
        } else {
          ctx.font = (m.fontWeight || "700") + " " + (m.fontSize || 11) + "px " + this.theme.font;
          ctx.fillText(m.text || "•", xx, yy + (above ? -2 : 8));
        }
        ctx.restore();
      });
    }

    // ---------------------------------------------------- drawings -----
    // horizontal / trendline / box — all code-driven (see addLine), always
    // rendered on the base layer only (they don't need a per-frame redraw).
    _drawDrawings(ctx, S) {
      this.drawings.forEach(d => this._drawOneDrawing(ctx, S, d));
    }

    _drawOneDrawing(ctx, S, d) {
      const L = this.L;
      ctx.save();
      ctx.strokeStyle = d.color || this.theme.up;
      ctx.lineWidth = d.width || 1.4;
      if (d.dash) ctx.setLineDash(d.dash);
      if (d.type === "horizontal") {
        const yy = S.y(d.y);
        ctx.beginPath(); ctx.moveTo(L.pl, yy); ctx.lineTo(L.W - L.pr, yy); ctx.stroke();
        if (d.label) {
          ctx.setLineDash([]);
          ctx.fillStyle = d.color || this.theme.up;
          ctx.font = "600 11px " + this.theme.font;
          ctx.textAlign = d.right ? "right" : "left";
          ctx.fillText(d.label, d.right ? L.W - L.pr : L.pl + 2, yy - 5);
        }
      } else if (d.type === "box" && d.p1 && d.p2) {
        const x1 = S.x(clamp(d.p1.i - S.a, 0, S.n - 1)), y1 = S.y(d.p1.price);
        const x2 = S.x(clamp(d.p2.i - S.a, 0, S.n - 1)), y2 = S.y(d.p2.price);
        const bx = Math.min(x1, x2), by = Math.min(y1, y2), bw = Math.abs(x2 - x1), bh = Math.abs(y2 - y1);
        ctx.globalAlpha = d.fillAlpha != null ? d.fillAlpha : 0.10;
        ctx.fillStyle = d.color || this.theme.up;
        ctx.fillRect(bx, by, bw, bh);
        ctx.globalAlpha = 1;
        ctx.strokeRect(bx, by, bw, bh);
        if (d.label) {
          ctx.setLineDash([]);
          ctx.fillStyle = d.color || this.theme.up;
          ctx.font = "600 11px " + this.theme.font;
          ctx.textAlign = "left";
          ctx.fillText(d.label, bx + 2, by + 12);
        }
      } else if (d.type === "trendline" && d.p1 && d.p2) {
        const x1 = S.x(d.p1.i - S.a), y1 = S.y(d.p1.price);
        const x2 = S.x(d.p2.i - S.a), y2 = S.y(d.p2.price);
        const dx = x2 - x1, dy = y2 - y1;
        let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
        if (Math.abs(dx) > 0.0001) {
          const slope = dy / dx;
          if (d.extendLeft) { sx1 = L.pl; sy1 = y1 - slope * (x1 - L.pl); }
          if (d.extendRight) { sx2 = L.W - L.pr; sy2 = y2 + slope * (sx2 - x2); }
        }
        ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke();
      }
      ctx.restore();
    }

    // ------------------------------------------------------- crosshair -
    _drawCrosshair(sx, sy, fromGroup) {
      const S = this._S; if (!S) return;
      let i = clamp(Math.round((sx - this.L.pl) / S.slot - 0.5), 0, S.n - 1);
      this._lastLocal = { sx, sy, i };
      this._drawOverlayLayer(this._lastLocal);
      const bar = S.vis[i];
      if (this.legendEl && bar) this.legendEl.innerHTML = this.legendHtml(bar, S.a + i);
      if (this.opts.onHover) this.opts.onHover(bar, S.a + i);
      if (this.opts.readoutEl && bar) this.opts.readoutEl.innerHTML = this.legendHtml(bar, S.a + i);
      if (this._group && !fromGroup) this._group._broadcastCrosshair(this, S.a + i);
    }

    _clearCrosshair(fromGroup) {
      this._lastLocal = null;
      this._drawOverlayLayer(null);
      if (this.legendEl && this.bars.length) {
        const last = this.bars.length - 1;
        this.legendEl.innerHTML = this.legendHtml(this.bars[last], last);
      }
      if (this.opts.onHover) this.opts.onHover(null, -1);
      if (this._group && !fromGroup) this._group._broadcastCrosshair(this, -1);
    }

    // draws crosshair lines + tags on the overlay canvas only
    _drawOverlayLayer(local) {
      if (!this.octx) return;
      const ctx = this.octx, L = this.L, S = this._S, th = this.theme;
      ctx.clearRect(0, 0, L.W, L.H);
      if (!S || !local) return;
      const { sx, sy, i } = local;
      const bar = S.vis[i]; if (!bar) return;
      const xc = S.x(i), cy = clamp(sy, L.yTop, L.yBot);

      ctx.save();
      ctx.strokeStyle = th.crosshair; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xc, L.yTop); ctx.lineTo(xc, L.yBot); ctx.stroke();
      if (!this.opts.compact) {
        ctx.beginPath(); ctx.moveTo(L.pl, cy); ctx.lineTo(L.W - L.pr, cy); ctx.stroke();
      }
      ctx.setLineDash([]);

      if (!this.opts.compact) {
        const val = S.padLo + (S.padHi - S.padLo) * (1 - (cy - L.yTop) / (L.yBot - L.yTop));
        const valTxt = this.opts.valueFormatter ? this.opts.valueFormatter(val) : fmtPrice(val);
        ctx.font = "700 10px " + th.font;
        const pw = ctx.measureText(valTxt).width + 8;
        ctx.fillStyle = th.panel;
        ctx.fillRect(L.W - L.pr, cy - 7.5, pw, 15);
        ctx.fillStyle = th.panelText; ctx.textAlign = "left";
        ctx.fillText(valTxt, L.W - L.pr + 4, cy + 3);
      }

      if (this.opts.showDateTag !== false) {
        const dateTxt = fmtDateFull(bar.d);
        const dw = 56, dxc = clamp(xc, L.pl + dw / 2, L.W - L.pr - dw / 2);
        ctx.fillStyle = th.panel;
        ctx.fillRect(dxc - dw / 2, L.H - 15, dw, 14);
        ctx.fillStyle = th.panelText; ctx.textAlign = "center";
        ctx.fillText(dateTxt, dxc, L.H - 5);
      }
      ctx.restore();
    }

    // -------------------------------------------------------- events ---
    // Only bound when opts.interactive !== false. Handles crosshair, pan,
    // zoom (wheel/pinch) and Group sync — no drawing-tool state at all.
    _bindEvents() {
      const el = this.overlay;
      let dragging = false, dragStartX = 0, dragStartView = null, pinchDist0 = null, pinchView0 = null;

      const toLocal = e => {
        const r = el.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
      };

      const onMove = e => {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = null;
          const p = toLocal(e);
          if (dragging) this._pan(p.x - dragStartX, dragStartView);
          this._drawCrosshair(p.x, p.y);
        });
      };
      const onLeave = () => { if (!dragging) this._clearCrosshair(); };

      el.addEventListener("mousemove", onMove);
      el.addEventListener("mouseleave", onLeave);
      el.addEventListener("touchmove", onMove, { passive: true });
      el.addEventListener("touchend", onLeave);

      el.addEventListener("mousedown", e => {
        const p = toLocal(e);
        dragging = true; dragStartX = p.x; dragStartView = Object.assign({}, this._view);
      });
      global.addEventListener("mouseup", () => { dragging = false; });

      el.addEventListener("touchstart", e => {
        if (e.touches.length === 1) { dragging = true; dragStartX = toLocal(e).x; dragStartView = Object.assign({}, this._view); }
        else if (e.touches.length === 2) { pinchDist0 = this._touchDist(e); pinchView0 = Object.assign({}, this._view); }
      }, { passive: true });
      el.addEventListener("touchmove", e => {
        if (e.touches.length === 2 && pinchDist0) {
          const d = this._touchDist(e), f = pinchDist0 / d;
          this._zoomAround((pinchView0.a + pinchView0.b) / 2, f, pinchView0);
        }
      }, { passive: true });
      el.addEventListener("touchend", () => { pinchDist0 = null; }, { passive: true });

      el.addEventListener("wheel", e => {
        e.preventDefault();
        const p = toLocal(e);
        const S = this._S; if (!S) return;
        const centerIdx = S.a + clamp((p.x - this.L.pl) / S.slot, 0, S.n);
        const factor = Math.exp(e.deltaY * 0.001);
        this._zoomAround(centerIdx, factor, this._view);
      }, { passive: false });
    }

    // separate from _bindEvents so even non-interactive/compact thumbnails
    // stay correctly sized without paying for any pointer listeners
    _bindResize() {
      this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
      if (this._ro) this._ro.observe(this.wrap);
    }

    _touchDist(e) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    _pan(dxPx, fromView) {
      const S = this._S; if (!S) return;
      const n = this.bars.length;
      const width = fromView.b - fromView.a;
      const shift = Math.round(-dxPx / S.slot);
      let a = clamp(fromView.a + shift, 0, n - width);
      this._view = { a, b: a + width };
      this.render();
      if (this._group) this._group._broadcastView(this, a, a + width);
    }

    _zoomAround(centerIdx, factor, fromView) {
      const n = this.bars.length;
      const width = fromView.b - fromView.a;
      let newWidth = clamp(Math.round(width * factor), 15, n);
      const ratio = (centerIdx - fromView.a) / width;
      let a = Math.round(centerIdx - ratio * newWidth);
      a = clamp(a, 0, n - newWidth);
      this._view = { a, b: a + newWidth };
      this.render();
      if (this._group) this._group._broadcastView(this, a, a + newWidth);
    }

    // called by Group — apply an externally-driven view/crosshair without re-broadcasting
    _applyView(a, b) { this.zoomTo(a, b, true); }
    _applyCrosshair(idx) {
      if (idx < 0) { this._clearCrosshair(true); return; }
      const S = this._S; if (!S) return;
      const i = clamp(idx - S.a, 0, S.n - 1);
      const x = S.x(i);
      this._drawCrosshair(x, (this.L.yTop + this.L.yBot) / 2, true);
    }
  }

  // ======================================================================
  // Chart — main candlestick pane (candles + volume + MAs + lines)
  // ======================================================================
  class Chart extends BasePane {
    constructor(container, opts) {
      super(container, Object.assign({ volume: true }, opts));
      this._computeMAs();
      this.resize();
    }

    _computeMAs() {
      const closes = this.bars.map(b => b.c);
      this._maSeries = (this.opts.ma || []).map(m => ({
        color: m.color || "#2563eb",
        width: m.width || 1.4,
        label: m.label || ((m.type || "sma").toUpperCase() + (m.period || "")),
        values: m._precomputed || (m.type === "ema" ? ema : sma)(closes, m.period)
      }));
    }

    setData(bars) { this.bars = bars || []; this._view = { a: 0, b: this.bars.length }; this._computeMAs(); this.render(); }
    setOptions(opts) { Object.assign(this.opts, opts || {}); if (opts && opts.ma) this._computeMAs(); this.render(); }

    _layout() {
      super._layout();
      const compact = !!this.opts.compact;
      const volH = this.opts.volume ? (compact ? 16 : 46) : 0;
      this.L.volH = volH;
      this.L.yBot = this.L.H - this.L.padB - volH;
      this.L.vy0 = this.L.H - this.L.padB;
    }

    _computeScales() {
      const { a, b } = this._view;
      const vis = this.bars.slice(a, b);
      const n = vis.length || 1;
      const L = this.L;
      const slot = (L.W - L.pl - L.pr) / n;
      const cw = Math.max(1, Math.min(13, slot * 0.72));
      const x = i => L.pl + slot * (i + 0.5);
      const lo = Math.min(...vis.map(bar => bar.l));
      const hi = Math.max(...vis.map(bar => bar.h));
      const lineVals = this.drawings.filter(d => d.type === "horizontal").map(d => d.y);
      const lo2 = Math.min(lo, ...(lineVals.length ? lineVals : [lo]));
      const hi2 = Math.max(hi, ...(lineVals.length ? lineVals : [hi]));
      const span = (hi2 - lo2) || 1;
      const padHi = hi2 + span * 0.06, padLo = Math.max(0, lo2 - span * 0.06);
      const y = v => L.yTop + (L.yBot - L.yTop) * (1 - (v - padLo) / (padHi - padLo));
      const vmax = Math.max(1, ...vis.map(bar => bar.v || 0));
      const yTicks = [];
      if (!this.opts.compact) for (let k = 0; k <= 3; k++) {
        const v = padLo + (padHi - padLo) * k / 3;
        yTicks.push({ v, label: "\u20B9" + fmtPrice(v) });
      }
      return { a, b, vis, n, slot, cw, x, y, padLo, padHi, vmax, yTicks };
    }

    _drawBase(ctx, S) {
      const th = this.theme, L = this.L;
      if (this.opts.volume) {
        for (let i = 0; i < S.n; i++) {
          const bar = S.vis[i], up = bar.c >= bar.o;
          const h = (bar.v || 0) / S.vmax * L.volH;
          ctx.fillStyle = up ? th.volUp : th.volDown;
          ctx.fillRect(S.x(i) - S.cw / 2, L.vy0 - h, S.cw, h);
        }
      }
      for (let i = 0; i < S.n; i++) {
        const bar = S.vis[i], up = bar.c >= bar.o, col = up ? th.up : th.down;
        const xc = S.x(i), yo = S.y(bar.o), yc = S.y(bar.c);
        const top = Math.min(yo, yc), bh = Math.max(0.8, Math.abs(yc - yo));
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xc, S.y(bar.h)); ctx.lineTo(xc, S.y(bar.l)); ctx.stroke();
        ctx.fillStyle = col;
        ctx.fillRect(xc - S.cw / 2, top, S.cw, bh);
      }
      this._maSeries.forEach(m => this._drawLine(ctx, S, m));
    }

    _drawLine(ctx, S, series) {
      ctx.strokeStyle = series.color; ctx.lineWidth = series.width; ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < S.n; i++) {
        const v = series.values[S.a + i];
        if (v == null) { started = false; continue; }
        const xx = S.x(i), yy = S.y(v);
        if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    legendHtml(bar, i) {
      const prev = i > 0 ? this.bars[i - 1] : null;
      const chg = (prev && prev.c) ? (bar.c / prev.c - 1) * 100 : (bar.o ? (bar.c / bar.o - 1) * 100 : 0);
      const up = chg >= 0;
      const chgCol = up ? this.theme.up : this.theme.down;
      const ohlcCol = bar.c >= bar.o ? this.theme.up : this.theme.down;
      const parts = [
        `<span style="color:${this.theme.text}">O</span> <b style="color:${ohlcCol}">${fmtPrice(bar.o)}</b>`,
        `<span style="color:${this.theme.text}">H</span> <b style="color:${ohlcCol}">${fmtPrice(bar.h)}</b>`,
        `<span style="color:${this.theme.text}">L</span> <b style="color:${ohlcCol}">${fmtPrice(bar.l)}</b>`,
        `<span style="color:${this.theme.text}">C</span> <b style="color:${ohlcCol}">${fmtPrice(bar.c)}</b>`,
        `<b style="color:${chgCol}">${up ? "+" : ""}${chg.toFixed(1)}%</b>`
      ];
      if (this.opts.volume) parts.push(`<span style="color:${this.theme.text}">Vol</span> <b style="color:${this.theme.text}">${fmtVol(bar.v)}</b>`);
      this._maSeries.forEach(m => {
        const v = m.values[i];
        parts.push(`<span style="color:${m.color}">\u25CF ${m.label} ${v == null ? "-" : fmtPrice(v)}</span>`);
      });
      return `<span style="color:${this.theme.text}">${bar.d}</span> &nbsp; ` + parts.join(" &nbsp; ");
    }
  }

  // ======================================================================
  // IndicatorPane — a synced sub-pane for RSI / MACD / volume-only / any
  // custom line or histogram series that shares the same date axis as a
  // main Chart. Crosshair + zoom/pan sync via FastChart.Group.
  // ======================================================================
  class IndicatorPane extends BasePane {
    constructor(container, opts) {
      super(container, Object.assign({ compact: false, showDateAxis: true }, opts));
      this.series = (opts.series || []).slice();
      this.bands = opts.bands || [];        // horizontal reference bands, e.g. RSI 70/30
      this.resize();
    }

    setSeries(series) { this.series = series || []; this.render(); }

    _computeScales() {
      const { a, b } = this._view;
      const vis = this.bars.slice(a, b);
      const n = vis.length || 1;
      const L = this.L;
      const slot = (L.W - L.pl - L.pr) / n;
      const cw = Math.max(1, Math.min(13, slot * 0.72));
      const x = i => L.pl + slot * (i + 0.5);
      let lo = Infinity, hi = -Infinity;
      this.series.forEach(s => {
        for (let i = a; i < b; i++) { const v = s.values[i]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      });
      (this.bands || []).forEach(bnd => { lo = Math.min(lo, bnd.y); hi = Math.max(hi, bnd.y); });
      if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
      const span = (hi - lo) || 1;
      const padHi = hi + span * 0.1, padLo = lo - span * 0.1;
      const y = v => L.yTop + (L.yBot - L.yTop) * (1 - (v - padLo) / (padHi - padLo));
      const yTicks = [];
      for (let k = 0; k <= 2; k++) { const v = padLo + (padHi - padLo) * k / 2; yTicks.push({ v, label: fmtPrice(v) }); }
      return { a, b, vis, n, slot, cw, x, y, padLo, padHi, yTicks };
    }

    _drawBase(ctx, S) {
      const th = this.theme, L = this.L;
      (this.bands || []).forEach(bnd => {
        const yy = S.y(bnd.y);
        ctx.save();
        ctx.strokeStyle = bnd.color || th.grid; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L.pl, yy); ctx.lineTo(L.W - L.pr, yy); ctx.stroke();
        ctx.restore();
      });
      this.series.forEach(s => {
        if (s.type === "histogram") {
          for (let i = 0; i < S.n; i++) {
            const v = s.values[S.a + i]; if (v == null) continue;
            const zero = S.y(0), yy = S.y(v);
            ctx.fillStyle = v >= 0 ? (s.colorUp || th.up) : (s.colorDown || th.down);
            ctx.fillRect(S.x(i) - S.cw / 2, Math.min(zero, yy), S.cw, Math.abs(zero - yy) || 1);
          }
        } else {
          ctx.strokeStyle = s.color || "#2563eb"; ctx.lineWidth = s.width || 1.4; ctx.lineJoin = "round";
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < S.n; i++) {
            const v = s.values[S.a + i];
            if (v == null) { started = false; continue; }
            const xx = S.x(i), yy = S.y(v);
            if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
          }
          ctx.stroke();
        }
      });
    }

    legendHtml(bar, i) {
      const parts = this.series.map(s => {
        const v = s.values[i];
        const col = s.type === "histogram" ? (v >= 0 ? (s.colorUp || this.theme.up) : (s.colorDown || this.theme.down)) : (s.color || "#2563eb");
        return `<span style="color:${col}">\u25CF ${s.name} ${v == null ? "-" : fmtPrice(v)}</span>`;
      });
      return `<span style="color:${this.theme.text}">${bar.d}</span> &nbsp; ` + parts.join(" &nbsp; ");
    }
  }

  // ======================================================================
  // Group — links multiple panes (Chart + IndicatorPane instances) so
  // crosshair position and visible range stay synced across all of them.
  // ======================================================================
  class Group {
    constructor(panes) {
      this.panes = [];
      (panes || []).forEach(p => this.add(p));
    }
    static link(panes) { return new Group(panes); }
    add(pane) {
      if (pane._group === this) return;
      if (pane._group) pane._group.remove(pane);
      pane._group = this;
      this.panes.push(pane);
      return this;
    }
    remove(pane) {
      this.panes = this.panes.filter(p => p !== pane);
      if (pane._group === this) pane._group = null;
    }
    _broadcastView(source, a, b) {
      this.panes.forEach(p => { if (p !== source) p._applyView(a, b); });
    }
    _broadcastCrosshair(source, idx) {
      this.panes.forEach(p => { if (p !== source) p._applyCrosshair(idx); });
    }
  }

  // ======================================================================
  // Handy overlay builders — same visual vocabulary as the earlier SVG-based
  // engine, exposed as composable (ctx,S,pane)=>void functions so callers
  // opt in with `chart.addOverlay(FastChart.overlayHelpers.boxes([...]))`.
  // ======================================================================
  const overlayHelpers = {
    /** Rectangular base/consolidation boxes anchored to real dates:
     *  {fromDate,toDate,high,low,label,color,alpha} */
    boxes(list) {
      return function (ctx, S, pane) {
        (list || []).forEach(bb => {
          let fi = pane.bars.findIndex(b => b.d >= bb.fromDate); if (fi < 0) return;
          let ti = bb.toDate ? pane.bars.findIndex(b => b.d > bb.toDate) : pane.bars.length - 1;
          ti = ti < 0 ? pane.bars.length - 1 : ti;
          fi -= S.a; ti -= S.a;
          if (ti < 0 || fi > S.n) return;
          fi = clamp(fi, 0, S.n - 1); ti = clamp(ti, 0, S.n - 1);
          const bx = S.x(fi) - S.cw / 2, bx2 = S.x(ti) + S.cw / 2, byT = S.y(bb.high), byB = S.y(bb.low);
          if (bx2 - bx <= 6 || byB - byT <= 3) return;
          const col = bb.color || "#1a8a4a";
          ctx.save();
          ctx.fillStyle = col; ctx.globalAlpha = bb.alpha != null ? bb.alpha : 0.08;
          ctx.fillRect(bx, byT, bx2 - bx, byB - byT);
          ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
          ctx.strokeRect(bx, byT, bx2 - bx, byB - byT);
          if (bb.label) { ctx.setLineDash([]); ctx.fillStyle = col; ctx.font = "9.5px " + pane.theme.font; ctx.textAlign = "left";
            ctx.fillText(bb.label, Math.max(pane.L.pl + 2, bx), Math.min(byB + 13, pane.L.yBot - 1)); }
          ctx.restore();
        });
      };
    },
    /** Small glyph markers anchored to a real date, drawn at a given price:
     *  {date, glyph, color, price} — for markers not tied to the bar's H/L,
     *  use pane.addMarkers() instead (position:'above'|'below'). */
    glyphs(list) {
      return function (ctx, S, pane) {
        (list || []).forEach(m => {
          const gi = pane.bars.findIndex(b => b.d === m.date); if (gi < 0) return;
          const i = gi - S.a; if (i < 0 || i >= S.n) return;
          const v = m.price != null ? m.price : S.vis[i].h;
          ctx.fillStyle = m.color || "#b8860b"; ctx.font = "11px " + pane.theme.font; ctx.textAlign = "center";
          ctx.fillText(m.glyph || "\u2022", S.x(i), S.y(v) - 7);
        });
      };
    }
  };

  // ======================================================================
  // Public API
  // ======================================================================
  const FastChart = {
    Chart, IndicatorPane, Group,
    themes, overlayHelpers,
    sma, ema,
    version: "1.0.0"
  };

  global.FastChart = FastChart;
})(typeof window !== "undefined" ? window : this);
