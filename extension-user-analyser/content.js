// Injects the panel into a closed shadow root on the Amazon page.
//
// A shadow root rather than the iframe the old extension uses: nothing has to
// be listed in web_accessible_resources, so no page can load this extension's
// HTML or probe for its presence, and Amazon's stylesheet cannot reach in and
// restyle the panel.
//
// Reads once at document_idle, then only when the user asks. No polling, no
// MutationObserver -- the page is static once loaded, and a watcher on an
// Amazon product page fires constantly for carousels and ads.

(function () {
  'use strict';

  const HOST_ID = 'isua-panel-host';
  if (document.getElementById(HOST_ID)) return;

  const readPage = globalThis.ISUA?.readPage;
  if (!readPage) {
    console.warn('[ISUA] readPage.js did not load; panel not shown');
    return;
  }

  /** Text for a field, honouring the never-guess rule. */
  function fieldText(f) {
    if (!f || !f.found) return 'not found';
    return f.text == null ? 'not found' : String(f.text);
  }

  function row(label, field) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    const strong = document.createElement('span');
    strong.className = 'isua-val';
    strong.textContent = fieldText(field);
    if (!field || !field.found) strong.classList.add('isua-missing');
    const src = document.createElement('span');
    src.className = 'isua-src';
    src.textContent = (field && field.source) || readPage.SRC_PAGE;
    dd.appendChild(strong);
    dd.appendChild(src);
    return [dt, dd];
  }

  function build(reading) {
    const wrap = document.createElement('div');
    wrap.className = 'isua-panel';

    const h = document.createElement('div');
    h.className = 'isua-head';
    const title = document.createElement('span');
    title.className = 'isua-title';
    title.textContent = 'InventorySprint — User Analyser';
    const ver = document.createElement('span');
    ver.className = 'isua-ver';
    ver.textContent = 'v0.1.0';
    h.appendChild(title);
    h.appendChild(ver);
    wrap.appendChild(h);

    const dl = document.createElement('dl');
    dl.className = 'isua-fields';
    const rows = [
      ['ASIN', reading.asin],
      ['Title', reading.title],
      ['Price', reading.price],
      ['Buy Box seller', reading.buyBoxSeller],
      ['Sellers', reading.sellerCount],
      ['BSR', reading.bsr],
      ['Availability', reading.availability],
      ['Variation parent', reading.variationParent],
      ['Book', reading.isBook],
    ];
    for (const [label, field] of rows) {
      const [dt, dd] = row(label, field);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    wrap.appendChild(dl);

    // Gating: a statement that we did not check, with no verdict and no
    // colour. See readPage.js gatingNotice() for why there is no value here.
    const gate = document.createElement('div');
    gate.className = 'isua-gate';
    const gLabel = document.createElement('div');
    gLabel.className = 'isua-gate-label';
    gLabel.textContent = 'Can I sell this?';
    const gText = document.createElement('div');
    gText.className = 'isua-gate-text';
    gText.textContent = reading.gating.text;
    const gLink = document.createElement('a');
    gLink.href = reading.gating.sellerCentralUrl;
    gLink.target = '_blank';
    gLink.rel = 'noopener noreferrer';
    gLink.className = 'isua-gate-link';
    gLink.textContent = 'Check in your own Seller Central →';
    gate.appendChild(gLabel);
    gate.appendChild(gText);
    gate.appendChild(gLink);
    wrap.appendChild(gate);

    const foot = document.createElement('div');
    foot.className = 'isua-foot';
    foot.textContent = 'Every value above was read from this page in your own browser. No seller account is used.';
    wrap.appendChild(foot);

    const actions = document.createElement('div');
    actions.className = 'isua-actions';
    const save = document.createElement('button');
    save.className = 'isua-btn';
    save.textContent = 'Save to my account';
    const status = document.createElement('span');
    status.className = 'isua-status';
    save.addEventListener('click', () => {
      save.disabled = true;
      status.textContent = 'Saving…';
      chrome.runtime.sendMessage({
        type: 'ISUA_SAVE_READING',
        reading: {
          asin: reading.asin.found ? reading.asin.value : null,
          title: reading.title.found ? reading.title.value : null,
          price_text: reading.price.found ? reading.price.text : null,
          buy_box_seller: reading.buyBoxSeller.found ? reading.buyBoxSeller.value : null,
          seller_count: reading.sellerCount.found ? reading.sellerCount.value : null,
          bsr: reading.bsr.found ? reading.bsr.value : null,
          page_url: location.href.split('?')[0],
        },
      }, (res) => {
        save.disabled = false;
        if (res?.ok) { status.textContent = 'Saved'; return; }
        status.textContent = res?.error === 'NOT_SIGNED_IN'
          ? 'Sign in at inventorysprint.com first'
          : `Could not save: ${res?.error || 'unknown error'}`;
      });
    });
    actions.appendChild(save);
    actions.appendChild(status);
    wrap.appendChild(actions);

    return wrap;
  }

  let reading;
  try {
    reading = readPage.extract(document, location.href);
  } catch (e) {
    console.warn('[ISUA] could not read this page:', e?.message || e);
    return;
  }

  // No ASIN means this is not a product page we understand. Show nothing
  // rather than an empty panel.
  if (!reading.asin.found) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = globalThis.ISUA_PANEL_CSS || '';
  shadow.appendChild(style);
  shadow.appendChild(build(reading));
  document.body.appendChild(host);
})();
