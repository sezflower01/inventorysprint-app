// The panel's stylesheet, delivered as a script rather than as manifest `css`.
//
// content.js mounts the panel in a CLOSED shadow root, and a shadow root does
// not inherit page stylesheets -- so a manifest "css" entry would be injected
// into Amazon's document and never reach the panel. Shipping the rules as a
// string and putting them in a <style> inside the shadow root is what makes
// the closed root possible, and the closed root is what keeps the panel out of
// web_accessible_resources and out of reach of Amazon's own CSS.
//
// Colours are defined for both themes. The panel floats over a page whose
// background we do not control, so the surface is painted explicitly rather
// than inherited.
globalThis.ISUA_PANEL_CSS = `
  :host { all: initial; }

  .isua-panel {
    --isua-bg: #ffffff;
    --isua-fg: #1a1d21;
    --isua-muted: #6b7280;
    --isua-line: #e3e6ea;
    --isua-accent: #1f5f8b;
    --isua-missing: #8a8f98;

    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483000;
    width: 320px;
    max-height: 70vh;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 14px 16px 12px;
    background: var(--isua-bg);
    color: var(--isua-fg);
    border: 1px solid var(--isua-line);
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(16, 24, 40, 0.14);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-color-scheme: dark) {
    .isua-panel {
      --isua-bg: #16191d;
      --isua-fg: #e8eaed;
      --isua-muted: #9aa0a6;
      --isua-line: #2c3137;
      --isua-accent: #6fb3dd;
      --isua-missing: #7c828a;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    }
  }

  .isua-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--isua-line);
  }
  .isua-title { font-weight: 600; font-size: 12.5px; letter-spacing: 0.01em; }
  .isua-ver { color: var(--isua-muted); font-size: 11px; }

  .isua-fields {
    display: grid;
    grid-template-columns: 104px 1fr;
    gap: 7px 10px;
    margin: 10px 0 12px;
  }
  .isua-fields dt { color: var(--isua-muted); font-size: 11.5px; }
  .isua-fields dd { margin: 0; display: flex; flex-direction: column; gap: 1px; min-width: 0; }

  .isua-val { overflow-wrap: anywhere; }
  /* "not found" is stated plainly and never styled as an alarm -- it means we
     did not read it, not that something is wrong with the product. */
  .isua-missing { color: var(--isua-missing); font-style: italic; }
  .isua-src { color: var(--isua-muted); font-size: 10.5px; }

  /* The gating block carries NO colour on purpose: no green, no red, no
     amber. It is a statement that nothing was checked, and any colour would
     read as a verdict. */
  .isua-gate {
    padding: 9px 10px;
    border: 1px dashed var(--isua-line);
    border-radius: 7px;
    margin-bottom: 10px;
  }
  .isua-gate-label { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
  .isua-gate-text { color: var(--isua-muted); font-size: 12px; }
  .isua-gate-link {
    display: inline-block;
    margin-top: 5px;
    color: var(--isua-accent);
    text-decoration: none;
    font-size: 12px;
  }
  .isua-gate-link:hover, .isua-gate-link:focus { text-decoration: underline; }

  .isua-foot {
    color: var(--isua-muted);
    font-size: 10.5px;
    border-top: 1px solid var(--isua-line);
    padding-top: 8px;
  }

  .isua-actions { display: flex; align-items: center; gap: 9px; margin-top: 9px; }
  .isua-btn {
    font: inherit;
    font-size: 12px;
    padding: 5px 11px;
    color: var(--isua-bg);
    background: var(--isua-accent);
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }
  .isua-btn:disabled { opacity: 0.55; cursor: default; }
  .isua-btn:focus-visible { outline: 2px solid var(--isua-accent); outline-offset: 2px; }
  .isua-status { color: var(--isua-muted); font-size: 11.5px; }

  @media (prefers-reduced-motion: reduce) {
    .isua-panel, .isua-btn { transition: none !important; }
  }
`;
