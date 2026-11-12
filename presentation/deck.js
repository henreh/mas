/* ==========================================================================
   Stochastic parrots and stochastic spiders — presentation shell.

   One flattened step model drives everything. Every manifest slide is one step,
   except a `build` slide, which owns a contiguous range of its embedded deck's
   steps and therefore contributes that many. The contract the screenshot
   harness relies on:

       window.deck = { get index(), steps: { length } }

   `index` is the global flattened position; one ArrowRight that does anything
   moves it by exactly one, whether that lands on the next slide or the next
   step inside an embedded visualisation.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------- state ------ */

  var SLIDES = [];          // manifest slides, decorated with _from/_to
  var STEPS = [];           // flattened: { slide: <index>, step: <int|null> }
  var SECTIONS = {};        // section id -> label
  var META = {};
  var idToStep = {};        // slide id -> first flattened index
  var panels = [];          // slide index -> DOM element
  var cur = 0;
  var ready = false;

  /* Published synchronously so the harness can read it the moment it asks. */
  window.deck = {
    get index() { return cur; },
    steps: STEPS,
    get slides() { return SLIDES; },
    get slide() { return STEPS[cur] ? SLIDES[STEPS[cur].slide] : null; },
    next: function () { go(1); },
    prev: function () { go(-1); },
    goTo: function (i) { setIndex(i); },
    diagnostics: []
  };

  var $ = function (sel) { return document.querySelector(sel); };

  var stage, slidesEl, buildsEl, railCount, progressFill;
  var notesEl, notesBody, notesPos, helpEl, buildDebtEl;

  /* ---------------------------------------------------------- helpers ---- */

  /* Only two typefaces set type on this stage: Hanken Grotesk and JetBrains
     Mono. Neither subset carries U+2192/U+2190, so an arrow written as a
     character would be painted by a system fallback — a third face on stage.
     The manifest keeps the arrows (the source documents use them); every one
     of them is drawn here instead, as a hairline shaft and a chevron in
     currentColor, so it inherits the size, weight and colour of the copy it
     sits in and no fallback font is ever consulted. */
  var ARROW_RE = /[→←]/;

  function markArrow(back) {
    var s = document.createElement('span');
    s.className = 'mark-arrow' + (back ? ' is-back' : '');
    var read = document.createElement('span');
    read.className = 'vh';
    read.textContent = back ? 'back to' : 'to';
    s.appendChild(read);
    return s;
  }

  function fillText(node, str) {
    String(str).split(/([→←])/).forEach(function (part) {
      if (part === '→') node.appendChild(markArrow(false));
      else if (part === '←') node.appendChild(markArrow(true));
      else if (part) node.appendChild(document.createTextNode(part));
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') {
      if (ARROW_RE.test(text)) fillText(n, text);
      else n.textContent = text;
    }
    return n;
  }

  /* Own properties only. `'__proto__' in {}` is true, and the value that comes
     back is Object.prototype, so a bare `in` turns any inherited name into a
     lookup that appears to succeed. */
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function has(v) { return typeof v === 'string' && v.trim() !== ''; }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /* Splits an unpaid-debt line into tag / owed artifact / source ids.
     Shapes in the manifest:
       "debt 14 — Jensen SAE feature visual (source: raindrop #1750070958)"
       "capture owed — Sky News headline screenshot (source verified: #1758...)"
       "drawing owed — two spiders passing a small note"
     The card is a mono tag over a hairline over one plain sentence. Anything
     the tag already says, or any internal protocol code, is stripped from the
     sentence rather than projected twice. */
  function parseTodo(raw) {
    var s = String(raw || '').trim();
    var head = '', rest = s;
    var m = s.match(/^([^—]{0,48}?)\s+—\s+([\s\S]+)$/);
    if (m) { head = m[1].trim(); rest = m[2].trim(); }

    var num = null, kind = 'artifact owed';
    var fm = head.match(/^debt\s*(\d+[a-z]?)$/i);
    if (fm) {
      num = fm[1];
    } else if (head) {
      kind = head;
    } else {
      var im = rest.match(/^debt\s*(\d+[a-z]?)\s*/i);
      if (im) { num = im[1]; rest = rest.slice(im[0].length); }
    }

    var srcs = [];
    var rd = rest.match(/#\d{4,}/g);
    if (rd) srcs.push('raindrop ' + rd.join(', '));
    var ax = rest.match(/arXiv\s*[\d.]+/gi);
    if (ax) srcs.push(ax.join(', '));

    /* a trailing parenthetical that is nothing but the source id is already
       shown on the source line — don't say it twice */
    rest = rest.replace(/\s*\((?:source|sources)\b[^)]*\)\s*$/i, '');
    /* nor the workflow note, nor a protocol reference: neither is content the
       room can act on */
    rest = rest.replace(/\s*\((?:PLACEHOLDER-VIS)[^)]*\)\s*/gi, ' ');
    rest = rest.replace(/\s*[—–-]\s*[A-Z]\d(?:\/[A-Z]\d)*(?=[.,;)]|\s*$)/g, '');
    /* the tag already carries the kind and the BLOCKING flag */
    rest = rest.replace(/^(?:artifact|capture|drawing|sketch|photo|evidence)\s+owed\s*[:—-]\s*/i, '');
    rest = rest.replace(/\bBLOCKING\s*[:.]\s*/g, '');
    rest = rest.replace(/\s{2,}/g, ' ').trim();

    return {
      num: num,
      kind: kind,
      what: rest,
      src: srcs.join('  ·  '),
      blocking: /BLOCKING/.test(s)
    };
  }

  function debtCard(raw, inline) {
    var d = parseTodo(raw);
    var card = el('aside', 'debt' + (inline ? ' is-inline' : ''));

    /* No pictogram. Async Forest ships two faces and neither carries a flag
       glyph; the mono tag and the dashed rule do the work. */
    var tag = el('div', 'debt-tag');
    tag.appendChild(el('span', 'mark', 'debt'));
    if (d.num) tag.appendChild(el('span', 'num', d.num));
    tag.appendChild(el('span', 'sep', '·'));
    tag.appendChild(el('span', 'kind', d.kind));
    if (d.blocking) tag.appendChild(el('span', 'blocking', 'blocking'));
    card.appendChild(tag);

    card.appendChild(el('hr', 'debt-rule'));
    card.appendChild(el('p', 'debt-what', d.what));
    if (d.src) card.appendChild(el('p', 'debt-src', d.src));
    return card;
  }

  var allImages = [];

  function figure(img) {
    var f = el('figure', 'fig');
    var im = document.createElement('img');
    im.src = img.src;
    im.alt = img.alt || '';
    im.decoding = 'async';
    f.appendChild(im);
    allImages.push(im);
    return f;
  }

  /* The stage is a fixed 1920x1080, so figure geometry is settled once and
     never changes. Size each image explicitly: fill its slot, but never
     upscale a small Excalidraw export past the point where it turns to mush.
     Explicit sizing also keeps the hairline frame hugging the picture rather
     than an object-fit letterbox. */
  function layoutFigures() {
    allImages.forEach(function (im) {
      var f = im.parentNode;
      if (!f) return;
      var aw = f.clientWidth, ah = f.clientHeight;
      var nw = im.naturalWidth, nh = im.naturalHeight;
      if (!aw || !ah || !nw || !nh) return;
      var cap = nw < 400 ? 2.6 : (nw < 800 ? 2.05 : 1.7);
      var k = Math.min(aw / nw, ah / nh, cap);
      im.style.width = Math.floor(nw * k) + 'px';
      im.style.height = Math.floor(nh * k) + 'px';
    });
    pinFigures();
  }

  /* Second pass. The figure slot had to be a definite box for the sizing above
     to have something to fit into; now that each picture has a real height,
     the boxes collapse onto their contents. Two things follow: stacked figures
     sit one gap apart instead of drifting to the middle of half the column
     each, and a caption ends up against the picture it names rather than
     against the bottom of the column. */
  function pinFigures() {
    var wraps = document.querySelectorAll('.figs');
    Array.prototype.forEach.call(wraps, function (wrap) {
      var ims = wrap.querySelectorAll('figure.fig > img');
      if (!ims.length) return;
      var stacked = wrap.classList.contains('is-stacked');
      var grid = wrap.classList.contains('is-grid');
      var gap = parseFloat(getComputedStyle(wrap).rowGap) || 0;
      var h = 0;
      if (grid) {
        /* two to a row: the block is as tall as the tallest picture in each
           row, summed — not the tallest picture on the slide, which would
           collapse every row but one */
        var rows = [];
        Array.prototype.forEach.call(ims, function (im, i) {
          var r = Math.floor(i / 2);
          rows[r] = Math.max(rows[r] || 0, im.offsetHeight);
        });
        rows.forEach(function (rh, i) { h += rh + (i ? gap : 0); });
      } else {
        Array.prototype.forEach.call(ims, function (im, i) {
          if (stacked) {
            im.parentNode.style.flex = '0 0 auto';
            h += im.offsetHeight + (i ? gap : 0);
          } else {
            h = Math.max(h, im.offsetHeight);
          }
        });
      }
      var host = wrap.parentNode;
      if (h && host && host.classList.contains('fig-group')) {
        wrap.style.flex = '0 0 auto';
        wrap.style.height = h + 'px';
      }
    });
  }

  function imagesSettled() {
    var pending = allImages.filter(function (im) { return !im.complete; });
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(function (im) {
      return new Promise(function (res) {
        im.addEventListener('load', res, { once: true });
        im.addEventListener('error', res, { once: true });
      });
    }));
  }

  function captionLine(text) {
    var wrap = el('div', 'fig-caption');
    wrap.appendChild(el('span', 'tick'));
    wrap.appendChild(el('p', 'caption', text));
    return wrap;
  }

  /* ------------------------------------------------------ reading list ---- */

  /* A slide that ends in "look this up" asks for it with
       "reading": [ { "text": "...", "url": "https://..." } ]
     and gets the caption block's family — mono, caption size, muted ink,
     under the same hairline — as a short list instead of one crammed
     sentence. Four to seven citations set as a paragraph are a wall; set as
     lines they are something a room can photograph and a reader can click.
     The accent is spent once, on the link underline, and never as a text
     fill: a page of blue citations would be the only blue on the screen and
     would read as the loudest thing on it (V-4). An item with no url is a
     plain <li> — a book with no landing page is still worth naming. */
  function readingBlock(s) {
    if (!Array.isArray(s.reading)) return null;
    var items = s.reading.filter(function (r) { return r && has(r.text); });
    if (!items.length) return null;

    var wrap = el('div', 'reading-block');
    wrap.appendChild(el('hr', 'rule'));
    wrap.appendChild(el('p', 'reading-head', 'Suggested reading'));

    var ul = el('ul', 'reading');
    items.forEach(function (r) {
      var li = el('li', 'reading-item');
      /* http(s) only, and always resolved by the browser, never interpolated
         into markup — a manifest string must not be able to become script */
      if (has(r.url) && /^https?:\/\//i.test(r.url.trim())) {
        var a = el('a', '', r.text);
        a.href = r.url.trim();
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      } else {
        fillText(li, r.text);
      }
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    return wrap;
  }

  /* ---------------------------------------------------------- columns ---- */

  /* Two lists that are one comparison, asked for with
       "columns": [ { "heading": "...", "items": [ "...", "..." ] }, { ... } ]
     Exactly two, side by side on one grid, so the room reads across the pair
     rather than down a stack of six bullets and reconstructing the pairing
     itself. Body type throughout, the deck's own ink for the marks, and no
     box around either column: two columns of type are already two columns
     (V-18 — no card-on-card). Anything that is not a pair is ignored and the
     slide renders exactly as it would have. */
  function columnsBlock(s) {
    if (!Array.isArray(s.columns) || s.columns.length !== 2) return null;
    var cols = s.columns.filter(function (c) {
      return c && (has(c.heading) || (Array.isArray(c.items) && c.items.length));
    });
    if (cols.length !== 2) return null;

    var grid = el('div', 'cols');
    cols.forEach(function (c) {
      var col = el('div', 'cols-col');
      if (has(c.heading)) col.appendChild(el('p', 'cols-head', c.heading));
      var list = (Array.isArray(c.items) ? c.items : []).filter(has);
      if (list.length) {
        var ul = el('ul', 'cols-list');
        list.forEach(function (t) { ul.appendChild(el('li', '', t)); });
        col.appendChild(ul);
      }
      grid.appendChild(col);
    });
    return grid;
  }

  /* ---------------------------------------------------------- bullets ---- */

  /* A sentence that resolves into a short list, asked for with
       "bullets": [ "...", "..." ]
     One plain list and nothing else: no heading, no links, no second column.
     It is the body paragraph carrying on, so it is set in the body's face,
     size and ink and marked with the same drawn ink dot the two-column lists
     use — the deck has one list idiom and this is it; a second marker style
     would read as a second kind of list. It renders directly under the body,
     or under the display where a slide has no body, everywhere a body renders:
     copy, quote, rule, hinge, title and the text column of an image slide.
     Sized in em like everything else in the box, so a list one item too long
     is shrunk by the autofit rather than pushed off the stage. An absent or
     empty list is ignored and the slide renders exactly as it would have. */
  function bulletsBlock(s) {
    if (!Array.isArray(s.bullets)) return null;
    var items = s.bullets.filter(has);
    if (!items.length) return null;
    var ul = el('ul', 'bullets');
    items.forEach(function (t) { ul.appendChild(el('li', '', t)); });
    return ul;
  }

  /* ---------------------------------------------------------- templates -- */

  /* D1's box-and-arrow vocabulary, as structure rather than as a sentence that
     happens to contain arrows. Each row is a chain of cells read left to right
     — input, transformation, prediction (D4) — and a cell can never be split
     across a line, so "one row becomes three" (A2, slides 15→16) reads as two
     more rows and not as two more lines of prose. Rows of equal length share a
     grid, so the arrows and the predictions stack into columns. */
  function flowBlock(rows) {
    var n = rows[0].length;
    var uniform = rows.length > 1 && rows.every(function (r) { return r.length === n; });
    var wrap = el('div', 'flow' + (uniform ? ' is-grid' : ''));
    if (uniform) {
      var cols = [];
      for (var i = 0; i < n; i++) { if (i) cols.push('max-content'); cols.push('max-content'); }
      wrap.style.gridTemplateColumns = cols.join(' ');
    }
    rows.forEach(function (cells) {
      var row = el('div', 'flow-row');
      cells.forEach(function (cell, i) {
        if (i) {
          var a = markArrow(false);
          a.className += ' flow-arrow';
          row.appendChild(a);
        }
        row.appendChild(el('span', 'flow-cell', cell));
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  function hasRows(s) { return Array.isArray(s.rows) && s.rows.length > 0; }

  /* D5, drawn instead of listed. A term of art is stapled onto a sentence the
     room has already understood: the phrase is highlighted where it stands and
     a short arrow points back up at it from a label. A slide asks for this with
       "annotations": [ { "phrase": "...", "label": "..." } ]
     and the phrase is marked in place inside `display`. The labels cannot be
     positioned here — the autofit pass changes the type size and therefore
     every line break — so they are laid out once, after the fit, by
     layoutAnnotations(). If a phrase is not found in the sentence nothing is
     marked and the slide renders exactly as it would have. */
  function annoList(s) {
    if (!Array.isArray(s.annotations)) return null;
    var out = s.annotations.filter(function (a) { return a && has(a.phrase) && has(a.label); });
    return out.length ? out : null;
  }

  function annotatedDisplay(text, annos) {
    var h = el('h1', 'display');
    var rest = String(text), marks = 0;
    annos.forEach(function (a, i) {
      var at = rest.indexOf(a.phrase);
      if (at < 0) return;
      if (at > 0) h.appendChild(document.createTextNode(rest.slice(0, at)));
      var m = el('span', 'anno-mark', a.phrase);
      m.dataset.anno = String(i);
      h.appendChild(m);
      rest = rest.slice(at + a.phrase.length);
      marks++;
    });
    if (rest) h.appendChild(document.createTextNode(rest));
    return marks ? h : el('h1', 'display', text);
  }

  function annoLayer(annos) {
    var layer = el('div', 'anno-layer');
    annos.forEach(function (a, i) {
      var note = el('div', 'anno-note');
      note.dataset.anno = String(i);
      note.appendChild(el('span', 'anno-stem'));
      note.appendChild(el('span', 'anno-label', a.label));
      layer.appendChild(note);
    });
    return layer;
  }

  function bodyBlock(s) {
    if (hasRows(s)) return flowBlock(s.rows);
    if (has(s.body)) return el('p', 'body', s.body);
    return null;
  }

  function headBlock(s, opts) {
    /* eyebrow + display + body (or the body's row diagram), and the bullet
       list that continues the body, in a fragment */
    var frag = document.createDocumentFragment();
    if (has(s.eyebrow)) frag.appendChild(el('p', 'eyebrow', s.eyebrow));
    if (has(opts && opts.display ? opts.display : s.display)) {
      frag.appendChild(el('h1', 'display', (opts && opts.display) || s.display));
    }
    var b = bodyBlock(s);
    if (b) frag.appendChild(b);
    var bl = bulletsBlock(s);
    if (bl) frag.appendChild(bl);
    return frag;
  }

  function tplTitle(s, box) {
    var stack = el('div', 'stack');
    stack.appendChild(el('div', 'accent-bar'));
    stack.appendChild(headBlock(s));
    box.appendChild(stack);

    if (has(s.caption)) {
      var foot = el('div', 'title-foot');
      foot.appendChild(el('hr', 'rule'));
      foot.appendChild(el('p', 'caption', s.caption));
      box.parentNode.appendChild(foot);
    }
  }

  /* The optional blocks any slide with a head block may carry, in the order
     they read: the comparison is content and sits with the claim; the reading
     list is apparatus and sits last, under its own hairline. */
  function addColumns(s, host) {
    var c = columnsBlock(s);
    if (c) host.appendChild(c);
  }

  function addReading(s, host) {
    var r = readingBlock(s);
    if (r) host.appendChild(r);
  }

  function tplCopy(s, box) {
    var stack = el('div', 'stack');
    stack.appendChild(headBlock(s));
    addColumns(s, stack);
    if (has(s.caption)) {
      stack.appendChild(el('hr', 'rule'));
      stack.appendChild(el('p', 'caption', s.caption));
    }
    addReading(s, stack);
    if (has(s.todo)) stack.appendChild(debtCard(s.todo, true));
    box.appendChild(stack);
  }

  /* The numbered rules stay the spine of the argument; they stop being
     *printed* as numbers. So no "Rule" mark and no numeral block — `rule` is
     now purely a type scale, the sentence set larger than a copy slide's, and
     any `Rule N:` prefix that survives in the manifest is stripped here so the
     slide surface can never show one. */
  function tplRule(s, box) {
    var text = String(s.display || '').replace(/^Rule\s+\d+\s*[:—-]\s*/, '');
    var annos = annoList(s);

    var stack = el('div', 'stack');

    var col = el('div', 'rule-text');
    if (annos) {
      col.className += ' has-anno';
      /* Optional `annotationOffset` (stage px, default 0) drops the labels
         further below the sentence they annotate. It buys the drop with
         padding and gives the same number straight back as negative margin,
         so the block the autofit measures and the box centres is exactly the
         height it was: the labels move, the headline does not. */
      var drop = Math.max(0, Number(s.annotationOffset) || 0);
      if (drop) {
        col.style.setProperty('--anno-offset', drop + 'px');
        col.dataset.annoOffset = String(drop);
      }
    }
    col.appendChild(annos ? annotatedDisplay(text, annos) : el('h1', 'display', text));
    if (annos) col.appendChild(annoLayer(annos));
    var rb = bodyBlock(s);
    if (rb) col.appendChild(rb);
    var rbul = bulletsBlock(s);
    if (rbul) col.appendChild(rbul);
    addColumns(s, col);
    if (has(s.caption)) {
      col.appendChild(el('hr', 'rule'));
      col.appendChild(el('p', 'caption', s.caption));
    }
    addReading(s, col);
    stack.appendChild(col);
    box.appendChild(stack);
  }

  function tplHinge(s, box) {
    var stack = el('div', 'stack');
    stack.appendChild(headBlock(s));
    addColumns(s, stack);
    if (has(s.caption)) stack.appendChild(el('p', 'caption', s.caption));
    addReading(s, stack);
    if (has(s.todo)) stack.appendChild(debtCard(s.todo, true));
    box.appendChild(stack);
  }

  function tplQuote(s, box) {
    var stack = el('div', 'stack');
    if (has(s.eyebrow)) stack.appendChild(el('p', 'eyebrow', s.eyebrow));
    stack.appendChild(el('div', 'quote-mark'));
    stack.appendChild(el('h1', 'display', s.display || ''));
    if (has(s.body)) stack.appendChild(el('p', 'body', s.body));
    var qbul = bulletsBlock(s);
    if (qbul) stack.appendChild(qbul);
    if (has(s.caption)) stack.appendChild(el('p', 'caption', s.caption));
    box.appendChild(stack);
  }

  function tplDebt(s, box) {
    var stack = el('div', 'stack');

    var claim = el('div', 'debt-claim');
    claim.appendChild(headBlock(s));
    if (has(s.caption)) {
      claim.appendChild(el('hr', 'rule'));
      claim.appendChild(el('p', 'caption', s.caption));
    }
    stack.appendChild(claim);

    var slot = el('div', 'debt-slot');
    slot.appendChild(debtCard(s.todo || 'artifact owed', false));
    stack.appendChild(slot);

    box.appendChild(stack);
  }

  /* Slide-level `"textSide": "right"` is `figure-right` mirrored: the figure
     column takes the left of the same two-column row and the type sits in a
     column on the right. It is a slide field rather than a fourth image
     `layout` token because a stacked pair has already spent its token on
     pair-top/pair-bottom — so this one setting composes with any arrangement
     of pictures, a single figure or a stack. What the right-hand column reads
     as is decided in the manifest and not here: the sentence in `body` is a
     caption-like aside beside the artifact, the same sentence in `display` is
     a headline (the two sizes are .col-text .display / .body in the
     stylesheet). Any other value, or no text to put in the column, and the
     slide renders exactly as it would have. */
  function tplImage(s, box) {
    var imgs = s.images || [];
    var layout = (imgs[0] && imgs[0].layout) || 'full';
    var hasText = has(s.display) || has(s.body) || hasRows(s);
    if (layout === 'figure-right' && !hasText) layout = 'full';

    var textRight = hasText && String(s.textSide || '').toLowerCase() === 'right';
    if (textRight) layout = 'figure-right';

    var stacked = imgs.length > 1 && /^pair-(top|bottom)$/.test(imgs[0].layout || '');
    /* `"layout": "grid"` on the first image tiles the pictures two to a row
       instead of laying them out side by side. It is how a slide carries a
       wall of evidence — four charts that are one argument — without spending
       four slides on it, and the caption underneath credits all of them. */
    var grid = imgs.length > 1 && (imgs[0].layout || '') === 'grid';
    var single = imgs.length === 1;

    function figs() {
      var wrap = el('div', 'figs' + (stacked ? ' is-stacked' : '') + (grid ? ' is-grid' : ''));
      imgs.forEach(function (i) { wrap.appendChild(figure(i)); });
      return wrap;
    }

    /* The picture and the line that names it travel together: the caption sits
       directly under the figure — never beside it — and the pair is what gets
       centred in the column. A slide carrying a single picture also centres it
       horizontally (.is-single, in the stylesheet); a pair keeps the shared
       left edge that lets the two images read as one stacked comparison. */
    function figGroup() {
      var g = el('div', 'fig-group' + (single ? ' is-single' : ''));
      g.appendChild(figs());
      if (has(s.caption)) g.appendChild(captionLine(s.caption));
      return g;
    }

    if (layout === 'figure-right') {
      var row = el('div', 'lay-row');
      var text = el('div', 'col-text');
      var tstack = el('div', 'stack is-tight');
      tstack.appendChild(headBlock(s));
      if (has(s.todo)) tstack.appendChild(debtCard(s.todo, true));
      text.appendChild(tstack);

      var figCol = el('div', 'lay-col');
      figCol.appendChild(figGroup());

      /* one row, two columns, the same widths either way round — only which
         side each one takes changes, and a flex row takes that from the order
         the two are appended in */
      if (textRight) { row.appendChild(figCol); row.appendChild(text); }
      else { row.appendChild(text); row.appendChild(figCol); }

      box.appendChild(row);
      box.__fitTargets = [text];
      return;
    }

    /* No display, no body: the artifact IS the slide. It gets the whole box —
       no head row above it, and no reserved column beside it — because a
       gutter the picture cannot use is width the picture has been charged for
       and never spent. */
    var col = el('div', 'lay-col');
    var head = null;
    var headFrag = headBlock(s);
    if (headFrag.childNodes.length) {
      head = el('div', 'col-head');
      var hstack = el('div', 'stack is-tight');
      hstack.appendChild(headFrag);
      head.appendChild(hstack);
      col.appendChild(head);
    }

    if (has(s.todo) && head) {
      /* an unpaid debt stands beside the artifact, in the space the artifact
         does not use — never stacked under it, which starves the picture */
      var pair = el('div', 'fig-pair');
      pair.appendChild(figGroup());
      var aside = el('div', 'fig-aside');
      aside.appendChild(debtCard(s.todo, true));
      pair.appendChild(aside);
      col.appendChild(pair);
    } else {
      col.appendChild(figGroup());
      if (has(s.todo)) {
        /* nothing above the picture to squeeze, so the debt goes under it and
           the artifact keeps the full width of the box */
        var under = el('div', 'fig-under');
        under.appendChild(debtCard(s.todo, true));
        col.appendChild(under);
      }
    }

    if (!head) box.className += ' is-bare';
    box.appendChild(col);
    box.__fitTargets = head ? [head] : [];
  }

  var TEMPLATES = {
    title: tplTitle, copy: tplCopy, rule: tplRule, hinge: tplHinge,
    quote: tplQuote, debt: tplDebt, image: tplImage
  };

  function buildPanel(s, i) {
    var panel = el('div', 'slide');
    panel.dataset.kind = s.kind;
    panel.dataset.id = s.id || ('slide-' + i);

    if (s.kind === 'build') {
      /* Full-bleed: the embedded deck draws its own copy. Nothing on top of
         it except an unpaid debt, which must stay visible (protocol C6). */
      return panel;
    }

    var box = el('div', 'body-box');
    panel.appendChild(box);
    (TEMPLATES[s.kind] || tplCopy)(s, box);
    return panel;
  }

  /* ------------------------------------------------------------ autofit -- */

  /* Display and body copy are set in em off the box's own root, so one number
     re-scales a long slide until it fits. The floor is set by the smallest em
     multiplier in that context, so no line can ever fall under the 24px stage
     minimum: 2em flow cells in a slide box, 1.9em body in an image column. */
  var FLOOR_SLIDE = 24 / 2;
  var FLOOR_COLUMN = 24 / 1.9;

  function fitBox(box, floor) {
    var stack = box.firstElementChild;
    if (!stack) return;
    var root = 16;
    box.style.fontSize = root + 'px';
    for (var i = 0; i < 7; i++) {
      var need = stack.offsetHeight;
      var avail = box.clientHeight;
      if (!need || !avail || need <= avail) break;
      var next = Math.max(floor, root * (avail / need) * 0.99);
      if (next >= root - 0.01) break;
      root = next;
      box.style.fontSize = root + 'px';
    }
  }

  /* A reading list is set in stage pixels rather than in the box's em, so the
     pass below cannot touch it — which is the point (a citation must never be
     allowed to drift under the 24px floor) but leaves one failure mode: a list
     one item longer than the slide can hold would push the type down and the
     headline would be shrunk to pay for it. So the list gives back its own two
     spare pixels first — 26 to the 24px floor, and not one step further. */
  var READ_MAX = 26, READ_MIN = 24;

  function fitReading() {
    var blocks = document.querySelectorAll('.reading-block');
    Array.prototype.forEach.call(blocks, function (block) {
      var box = block.closest && block.closest('.body-box');
      if (!box) return;
      var stack = box.firstElementChild;
      var ul = block.querySelector('ul.reading');
      if (!stack || !ul) return;
      for (var size = READ_MAX; size > READ_MIN; size--) {
        if (stack.offsetHeight <= box.clientHeight) break;
        ul.style.fontSize = (size - 1) + 'px';
      }
    });
  }

  function fitAll() {
    panels.forEach(function (p) {
      var box = p.querySelector('.body-box');
      if (!box) return;
      if (box.__fitTargets) {
        box.__fitTargets.forEach(function (t) { fitBox(t, FLOOR_COLUMN); });
      } else {
        fitBox(box, FLOOR_SLIDE);
      }
    });
  }

  /* Placed after the autofit, for the same reason layoutFigures() is: the
     stage is a fixed 1920x1080, so once the type has settled the geometry is
     settled, and a label can be pinned under the phrase it names. A label is
     centred on its phrase, clamped inside the column, and pushed onto a second
     row if it would collide with one already placed — so two terms of art
     annotated out of the same sentence never sit on top of each other. */
  var ANNO_DROP = 26;          /* mark bottom -> label top, first row  */
  var ANNO_ROW  = 64;          /* extra stem for each row after the first */

  function layoutAnnotations() {
    var cols = document.querySelectorAll('.has-anno');
    Array.prototype.forEach.call(cols, function (col) {
      var layer = col.querySelector('.anno-layer');
      if (!layer) return;
      var base = col.getBoundingClientRect();
      if (!base.width) return;
      /* how far below the phrase the label hangs, over and above ANNO_DROP */
      var drop = parseFloat(col.dataset.annoOffset) || 0;

      var notes = [];
      Array.prototype.forEach.call(layer.children, function (note) {
        var mark = col.querySelector('.anno-mark[data-anno="' + note.dataset.anno + '"]');
        if (!mark) { note.style.display = 'none'; return; }
        /* A marked phrase can wrap, and then its bounding box spans two lines
           and its centre lands in the gutter between them. Point the arrow at
           the fragment on the LAST line instead — that is the one the label
           sits under. */
        var rects = mark.getClientRects();
        var r = rects.length ? rects[rects.length - 1] : mark.getBoundingClientRect();
        notes.push({
          note: note,
          cx: r.left + r.width / 2 - base.left,
          bottom: r.bottom - base.top
        });
      });
      notes.sort(function (a, b) { return a.cx - b.cx; });

      var placed = [];
      notes.forEach(function (n) {
        n.note.style.display = '';
        n.note.style.top = n.bottom + 'px';
        var w = n.note.offsetWidth;
        var left = Math.max(0, Math.min(base.width - w, n.cx - w / 2));
        var row = 0;
        for (var i = 0; i < placed.length; i++) {
          if (placed[i].row === row && left < placed[i].right + 28) row = placed[i].row + 1;
        }
        n.note.style.left = left + 'px';
        /* The stem lengthens by the offset rather than travelling with the
           label: the head must keep touching the phrase it points at, or the
           arrow stops naming anything. */
        var stem = n.note.querySelector('.anno-stem');
        if (stem) stem.style.height = (ANNO_DROP + drop + row * ANNO_ROW) + 'px';
        placed.push({ row: row, left: left, right: left + w });
      });
    });
  }

  /* ------------------------------------------------------- build iframes -- */

  /* Only the builds the neighbouring slides can reach are kept alive: the one
     on screen, the one the next arrow enters, the one the back arrow returns
     to. Anything further away is torn down. An embedded build is a live
     1920x1080 canvas scene; a stack of dormant ones costs hundreds of MB and,
     worse, makes every subsequent frame of the shell expensive to paint. */
  var frames = [];              // { file, el, ready, index, count, wanted, tries, shown }

  function frameFor(file, create) {
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].file === file) return frames[i];
    }
    if (!create) return null;

    var rec = {
      file: file, el: null, ready: false, index: -1, count: 0,
      wanted: null, tries: 0, shown: false
    };
    var f = document.createElement('iframe');
    f.setAttribute('title', 'visualisation');
    f.setAttribute('scrolling', 'no');
    f.src = file;
    f.addEventListener('load', function () {
      try { f.contentWindow.postMessage({ type: 'sk-query' }, '*'); } catch (e) {}
    });
    rec.el = f;
    frames.push(rec);
    buildsEl.appendChild(f);
    return rec;
  }

  function destroyFrame(rec) {
    var i = frames.indexOf(rec);
    if (i >= 0) frames.splice(i, 1);
    if (!rec.el) return;
    try { rec.el.src = 'about:blank'; } catch (e) {}
    if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    rec.el = null;
  }

  /* Which build files the slides either side of this one need. */
  function nearbyFiles(slideIndex) {
    var out = {};
    for (var k = slideIndex - 1; k <= slideIndex + 1; k++) {
      var s = SLIDES[k];
      if (s && !isParked(s) && s.kind === 'build' && s.build) out[s.build.file] = 1;
    }
    return out;
  }

  function reap(slideIndex) {
    var keep = nearbyFiles(slideIndex);
    frames.slice().forEach(function (f) { if (!keep[f.file]) destroyFrame(f); });
  }

  function post(rec, msg) {
    try { rec.el.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  /* Show the frame that is on; park the ones that already had their turn.
     Parking is display:none — the only state in which Chrome stops running the
     inner deck's animation loop. A frame that has not been shown yet stays
     laid out but invisible, so it boots against a real 1920x1080 viewport. */
  function park(rec, isCurrent) {
    rec.el.classList.toggle('is-current', isCurrent);
    rec.el.classList.toggle('is-idle', !isCurrent && !!rec.shown);
  }

  /* Entering a build fresh jumps (sk-goto). Continuing inside one — including
     across the boundary between two manifest slides that share a build file —
     steps (sk-step), so the inner deck animates rather than reloading. */
  function driveTo(rec, target, continuous, force) {
    rec.wanted = target;
    rec.tries = 0;
    rec.continuous = continuous && !force;
    rec.force = !!force;
    applyWant(rec);
  }

  function applyWant(rec) {
    if (rec.wanted == null || !rec.ready) return;
    if (rec.index === rec.wanted && !rec.force) return;
    var d = rec.wanted - rec.index;
    rec.force = false;
    if (rec.continuous && (d === 1 || d === -1)) {
      post(rec, { type: 'sk-step', dir: d });
    } else {
      post(rec, { type: 'sk-goto', index: rec.wanted });
    }
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.type !== 'sk-state') return;
    for (var i = 0; i < frames.length; i++) {
      var rec = frames[i];
      if (!rec.el || rec.el.contentWindow !== e.source) continue;
      var first = !rec.ready;
      rec.ready = true;
      if (typeof m.index === 'number') rec.index = m.index;
      if (typeof m.count === 'number') rec.count = m.count;
      rec.atStart = !!m.atStart;
      rec.atEnd = !!m.atEnd;
      if (first) rec.tries = 0;
      if (rec.wanted != null && rec.index !== rec.wanted && rec.tries < 8) {
        rec.tries++;
        applyWant(rec);
      }
      return;
    }
  });

  function prefetch(slideIndex) {
    var s = SLIDES[slideIndex];
    if (s && !isParked(s) && s.kind === 'build' && s.build) frameFor(s.build.file, true);
  }

  /* --------------------------------------------------------- navigation -- */

  function setIndex(i, opts) {
    i = Math.max(0, Math.min(STEPS.length - 1, i | 0));
    var prev = STEPS[cur];
    cur = i;
    render(prev, opts || {});
  }

  function go(delta) {
    if (!ready) return;
    setIndex(cur + delta);
  }

  function render(prevStep, opts) {
    var step = STEPS[cur];
    if (!step) return;
    var s = SLIDES[step.slide];

    /* slide panels */
    panels.forEach(function (p, i) { p.classList.toggle('is-current', i === step.slide); });

    stage.dataset.kind = s.kind;
    stage.dataset.mode = (s.kind === 'hinge') ? 'dark' : 'light';

    /* embedded build */
    if (s.kind === 'build' && s.build) {
      var rec = frameFor(s.build.file, true);
      var wasParked = rec.el.classList.contains('is-idle');
      rec.shown = true;
      frames.forEach(function (f) { park(f, f === rec); });
      var continuous = !!(prevStep &&
        SLIDES[prevStep.slide].kind === 'build' &&
        SLIDES[prevStep.slide].build &&
        SLIDES[prevStep.slide].build.file === s.build.file);
      driveTo(rec, step.step, continuous, wasParked);
    } else {
      frames.forEach(function (f) { park(f, false); });
    }

    /* debt pinned over a full-bleed build */
    while (buildDebtEl.firstChild) buildDebtEl.removeChild(buildDebtEl.firstChild);
    if (s.kind === 'build' && has(s.todo)) {
      buildDebtEl.appendChild(debtCard(s.todo, true));
      buildDebtEl.classList.add('is-on');
    } else {
      buildDebtEl.classList.remove('is-on');
    }

    /* chrome — the step counter and the progress bar, and nothing else. The
       bottom-left section tag is gone: it said the same thing on every slide of
       a section, which is clutter rather than orientation. The section label is
       still carried in meta.sections and still reaches the presenter through the
       notes overlay, where it costs the room nothing. */
    railCount.textContent = pad(cur + 1, 3) + ' / ' + STEPS.length;
    progressFill.style.width = ((cur + 1) / STEPS.length * 100).toFixed(3) + '%';

    /* hash */
    var id = s.id || '';
    if (id && ('#' + id) !== location.hash) {
      try { history.replaceState(null, '', location.pathname + location.search + '#' + id); }
      catch (e) {}
    }

    /* lazy-load one slide ahead (and one behind, so backwards entry is warm),
       then tear down every build the neighbouring slides cannot reach */
    prefetch(step.slide + 1);
    prefetch(step.slide - 1);
    reap(step.slide);

    if (notesEl.classList.contains('is-open')) renderNotes();

    bridgePost();
  }

  /* -------------------------------------------------------------- notes -- */

  function renderNotes() {
    var step = STEPS[cur];
    var s = SLIDES[step.slide];

    var pos = pad(cur + 1, 3) + ' / ' + STEPS.length;
    if (s.kind === 'build' && s.build) {
      pos += '  ·  step ' + (step.step + 1) + '/' + s.build.steps;
    }
    notesPos.textContent = pos;

    while (notesBody.firstChild) notesBody.removeChild(notesBody.firstChild);

    var meta = (s.id || '') + '  ·  ' + s.kind + '  ·  ' + (SECTIONS[s.section] || s.section || '');
    notesBody.appendChild(el('p', 'note-label', s.eyebrow || 'slide'));
    notesBody.appendChild(el('p', 'note-meta', meta));

    if (has(s.display)) notesBody.appendChild(el('p', 'note-lead', s.display));
    if (has(s.body)) notesBody.appendChild(el('p', 'note-text', s.body));
    if (has(s.caption)) notesBody.appendChild(el('p', 'note-meta', s.caption));

    if (s.kind === 'build' && s.build) {
      notesBody.appendChild(el('hr'));
      notesBody.appendChild(el('p', 'note-label', 'build'));
      notesBody.appendChild(el('p', 'note-meta',
        s.build.file.replace('../builds/', '') +
        '  ·  steps ' + (s._from + 1) + '–' + (s._to + 1) + ' of ' + s.build.steps));
    }
    if (s.replaces && s.replaces.length) {
      notesBody.appendChild(el('p', 'note-meta', 'replaces draft slides ' + s.replaces.join(', ')));
    }

    if (has(s.notes)) {
      notesBody.appendChild(el('hr'));
      notesBody.appendChild(el('p', 'note-label', 'spoken'));
      notesBody.appendChild(el('p', 'note-text', s.notes));
    }
    if (has(s.todo)) {
      notesBody.appendChild(el('hr'));
      notesBody.appendChild(el('p', 'note-label', 'unpaid debt'));
      notesBody.appendChild(el('p', 'note-text', s.todo));
    }
    notesBody.scrollTop = 0;
  }

  function toggleNotes(force) {
    var open = force != null ? force : !notesEl.classList.contains('is-open');
    if (open) { renderNotes(); notesEl.classList.add('is-open'); }
    else notesEl.classList.remove('is-open');
  }

  function toggleHelp(force) {
    var open = force != null ? force : !helpEl.classList.contains('is-open');
    helpEl.classList.toggle('is-open', open);
  }

  function anyOverlay() {
    return notesEl.classList.contains('is-open') || helpEl.classList.contains('is-open');
  }

  /* ------------------------------------------------------------- bridge -- */

  /* The presenter companion (presentation/companion.html) runs on the second
     screen: it follows this deck, and it can drive it. The two windows are
     served from the same origin by presentation/serve.sh, so one same-origin
     BroadcastChannel is the whole transport — no opener relationship, no
     postMessage target, and either window can be opened, closed and reopened
     without the other noticing.

       deck -> companion   { type: 'state',
                             index:      <flattened step index, 0-based>,
                             count:      <total flattened steps>,
                             slideId:    '<id>',
                             slideIndex: <manifest position>,
                             kind:       '<slide kind>',
                             build:      { step: <1-based>, of: <steps in the
                                           build file> } | null,
                             flat:       [ { id, step }, ... ] }

         posted on every render, and again in reply to a hello. `flat` is this
         file's own flattened step list — the one place the build-range logic
         lives — and it rides on EVERY state, not only on the hello reply: it
         is ninety-odd two-field objects, it costs nothing next to a render,
         and carrying it always means a companion that opened before this deck
         (or stayed open across a reload with a re-ordered manifest) can never
         spend a window applying our `index` to a flattening that is not ours.

       companion -> deck   { type: 'hello' }
                           { type: 'nav',  delta: 1 | -1 }
                           { type: 'goto', index } | { type: 'goto', id }

         acted on only once the deck is `ready`. `nav` moves one step and only
         one: any delta that is not exactly +1 or -1 is a malformed message and
         is dropped rather than rounded into a move.

     This block is the one description of the wire; presentation/companion.js
     points at it rather than restating it.

     Nothing in here may break a render: the channel is opened only if the
     browser has one, and every post and every inbound message is wrapped. A
     deck with no companion open is posting into an empty channel, which costs
     nothing. */

  var BRIDGE_CHANNEL = 'ai2026-deck';
  var bridge = null;

  function bridgeState() {
    var step = STEPS[cur];
    if (!step) return null;
    var s = SLIDES[step.slide];
    return {
      type: 'state',
      index: cur,
      count: STEPS.length,
      slideId: s.id || '',
      slideIndex: step.slide,
      kind: s.kind || '',
      build: (s.kind === 'build' && s.build)
        ? { step: (step.step | 0) + 1, of: s.build.steps | 0 }
        : null,
      flat: STEPS.map(function (st) {
        return { id: SLIDES[st.slide].id || '', step: st.step };
      })
    };
  }

  function bridgePost() {
    if (!bridge) return;
    try {
      var msg = bridgeState();
      if (msg) bridge.postMessage(msg);
    } catch (e) {}
  }

  function onBridgeMessage(e) {
    if (!ready) return;
    var m = e && e.data;
    if (!m) return;
    try {
      if (m.type === 'hello') { bridgePost(); return; }
      /* One step, in a named direction, or nothing: a message with no delta,
         a string delta or a 0 is malformed, and must not read as "forward". */
      if (m.type === 'nav') {
        if (m.delta === 1 || m.delta === -1) go(m.delta);
        return;
      }
      if (m.type === 'goto') {
        if (typeof m.index === 'number') setIndex(m.index);
        /* hasOwnProperty, not `in`: '__proto__' and 'constructor' are in every
           plain object, and Object.prototype | 0 is 0 — an id off the prototype
           chain would silently jump the deck to slide one. */
        else if (typeof m.id === 'string' && own(idToStep, m.id)) setIndex(idToStep[m.id]);
      }
    } catch (err) {}
  }

  function openBridge() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      bridge = new BroadcastChannel(BRIDGE_CHANNEL);
      bridge.onmessage = onBridgeMessage;
    } catch (e) { bridge = null; }
  }

  /* `c` opens the companion on the second screen; a second press raises the
     window already open rather than opening — or reloading — another.

     The window NAME alone is not enough: window.open(url, name) re-navigates a
     window that already carries that name, so a stray second press mid-talk
     would throw away the companion's scroll position and its link. Keep the
     handle instead, and only ever open when there is nothing live to raise. */
  var companionWin = null;

  function openCompanion() {
    try {
      if (companionWin && !companionWin.closed) { companionWin.focus(); return; }
      companionWin = window.open('companion.html', 'ai2026-companion');
      if (!companionWin) {
        window.deck.diagnostics.push(
          'companion window blocked: the browser refused window.open — allow pop-ups ' +
          'for this origin, or open presentation/companion.html by hand.');
      }
    } catch (e) {
      companionWin = null;
      window.deck.diagnostics.push('companion window failed to open: ' + e.message);
    }
  }

  /* --------------------------------------------------------------- fit ---- */

  function scaleStage() {
    var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%, -50%) scale(' + k + ')';
  }

  /* -------------------------------------------------------------- input -- */

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;

    if (k === 'Escape') { toggleNotes(false); toggleHelp(false); e.preventDefault(); return; }
    if (k === '?' || (k === '/' && e.shiftKey)) { toggleHelp(); e.preventDefault(); return; }
    if (k === 'n' || k === 'N') { toggleNotes(); e.preventDefault(); return; }
    if (k === 'c' || k === 'C') { openCompanion(); e.preventDefault(); return; }
    if (k === 'f' || k === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
      e.preventDefault();
      return;
    }

    if (k === 'ArrowRight' || k === ' ' || k === 'Spacebar' || k === 'PageDown') { go(1); e.preventDefault(); return; }
    if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { go(-1); e.preventDefault(); return; }
    if (k === 'Home') { setIndex(0); e.preventDefault(); return; }
    if (k === 'End') { setIndex(STEPS.length - 1); e.preventDefault(); return; }
  }

  /* A citation is the only thing on the stage with somewhere else to go. The
     slide layer is pointer-events:none so that a click anywhere advances the
     deck; deck.css hands the pointer back to `.slide.is-current ul.reading a`
     and nothing else, and this handler lets that one click through to the
     browser — the link opens in its own tab (target/rel are set where the list
     is built) and the deck stays on the slide the room is looking at. */
  function onClick(e) {
    if (notesEl.contains(e.target) || helpEl.contains(e.target)) return;
    var link = e.target && e.target.closest ? e.target.closest('a') : null;
    if (anyOverlay()) {
      /* the first click after an overlay is up spends itself dismissing the
         overlay, including one that lands on a citation still showing beside
         the notes panel */
      if (link) e.preventDefault();
      toggleNotes(false); toggleHelp(false);
      return;
    }
    if (link) return;
    go(1);
  }

  function onHash() {
    var id = decodeURIComponent((location.hash || '').slice(1));
    if (!id) return;
    if (!own(idToStep, id)) return;
    if (STEPS[cur] && SLIDES[STEPS[cur].slide].id === id) return;
    setIndex(idToStep[id]);
  }

  /* Keys must reach the shell, never a build. The iframes are
     pointer-events:none, but guard focus anyway. */
  function guardFocus() {
    var a = document.activeElement;
    if (a && a.tagName === 'IFRAME') { a.blur(); window.focus(); }
  }

  /* --------------------------------------------------------------- boot -- */

  /* The parking lot (G7). A parked slide keeps its id, its content and its
     place in the manifest — the deck simply never walks it, so it contributes
     no step, no counter position and no build range, and can be flipped back on
     by deleting one flag. */
  function isParked(s) { return !!(s && s.parked); }

  function computeRanges() {
    /* A build slide runs from its enterStep up to just before the next
       enterStep used anywhere in the manifest for the same file — so two
       manifest slides on one build hand a step range over rather than
       replaying it. The last user of a file runs to that file's end. */
    var byFile = {};
    SLIDES.forEach(function (s) {
      if (s.kind !== 'build' || !s.build || isParked(s)) return;
      var f = s.build.file;
      (byFile[f] = byFile[f] || []).push(s.build.enterStep | 0);
    });
    Object.keys(byFile).forEach(function (f) {
      byFile[f] = byFile[f].filter(function (v, i, a) { return a.indexOf(v) === i; })
                           .sort(function (a, b) { return a - b; });
    });
    SLIDES.forEach(function (s) {
      if (s.kind !== 'build' || !s.build || isParked(s)) return;
      var list = byFile[s.build.file];
      var from = s.build.enterStep | 0;
      var next = null;
      for (var i = 0; i < list.length; i++) { if (list[i] > from) { next = list[i]; break; } }
      var to = (next == null) ? (s.build.steps | 0) - 1 : next - 1;
      s._from = from;
      s._to = Math.max(from, to);
    });
  }

  function flatten() {
    STEPS.length = 0;
    SLIDES.forEach(function (s, i) {
      if (isParked(s)) return;
      if (s.kind === 'build' && s.build) {
        for (var k = s._from; k <= s._to; k++) STEPS.push({ slide: i, step: k });
      } else {
        STEPS.push({ slide: i, step: null });
      }
    });
    /* a deep link lands on the FIRST flattened step of its slide — which, for
       a build, is that slide's enterStep */
    idToStep = {};
    STEPS.forEach(function (st, n) {
      var id = SLIDES[st.slide].id;
      if (id && !(id in idToStep)) idToStep[id] = n;
    });
  }

  function start(data) {
    META = data.meta || {};
    (META.sections || []).forEach(function (sec) { SECTIONS[sec.id] = sec.label; });
    (data.slides || []).forEach(function (s) { SLIDES.push(s); });

    computeRanges();
    flatten();

    var frag = document.createDocumentFragment();
    SLIDES.forEach(function (s, i) {
      var p = buildPanel(s, i);
      panels.push(p);
      frag.appendChild(p);
    });
    slidesEl.appendChild(frag);

    var startAt = 0;
    var id = decodeURIComponent((location.hash || '').slice(1));
    if (id && own(idToStep, id)) startAt = idToStep[id];

    var finish = function () {
      fitReading();
      fitAll();
      layoutAnnotations();
      layoutFigures();
      ready = true;
      cur = startAt;
      render(null, { instant: true });
      window.addEventListener('hashchange', onHash);
    };

    var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    Promise.all([fonts, imagesSettled()]).then(finish, finish);
  }

  /* Which manifest to run. `?manifest=<path>.json` lets a candidate deck be
     rendered and screenshotted without touching the generated
     presentation/slides.json — the file check-manifest.js and
     tools/assemble-deck.js own. Same-origin relative JSON only (no scheme, no
     protocol-relative host, no traversal); anything else silently falls back
     to the real manifest, which stays the default in every other case. */
  function manifestUrl() {
    var m = /[?&]manifest=([^&]*)/.exec(location.search || '');
    var v = m ? decodeURIComponent(m[1]) : '';
    if (!v) return 'slides.json';
    if (v.indexOf('..') >= 0) return 'slides.json';
    if (!/^\/?[\w.\-]+(?:\/[\w.\-]+)*\.json$/.test(v)) return 'slides.json';
    return v;
  }

  function init() {
    stage = $('#stage');
    slidesEl = $('#slides');
    buildsEl = $('#builds');
    railCount = $('#rail-count');
    progressFill = $('#progress-fill');
    notesEl = $('#notes');
    notesBody = $('#notes-body');
    notesPos = $('#notes-pos');
    helpEl = $('#help');
    buildDebtEl = $('#build-debt');

    openBridge();

    scaleStage();
    window.addEventListener('resize', scaleStage);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    window.addEventListener('blur', function () { setTimeout(guardFocus, 0); });

    fetch(manifestUrl(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(start)
      .catch(function (err) {
        window.deck.diagnostics.push('manifest load failed: ' + err.message);
        var p = el('div', 'body-box');
        p.appendChild(el('h1', 'display', 'The slide manifest did not load.'));
        slidesEl.appendChild(p);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
