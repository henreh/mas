/* ==========================================================================
   Presenter companion — the second screen.

   Screen 1 is presentation/index.html, fullscreen and shared on the call.
   Screen 2 is this page. It tracks the deck, drives the deck, and shows, for
   whatever step the deck is on, the presenter SCRIPT: companion.json's notes,
   a line-marked list (see scriptParse below) set large enough to read at arm's
   length, six lines to a screen. Behind `d` (or the Details button) sits the
   one thing the script deliberately leaves out: what the slide points at,
   one bullet per sentence, with its sources. The manifest's own decision-
   record notes are not shown here at all (Henry, 15 Sep 2026: noise).

   THE WIRE. One same-origin BroadcastChannel, 'ai2026-deck'. The message
   shapes are written down once, in presentation/deck.js — search that file for
   "bridge" — and deliberately not restated here. What belongs here is the half
   of the contract that is this page's own:

     · Until a deck has spoken, this page flattens one step per slide so it is
       useful with no deck open at all. That stand-in list is NOT the deck's:
       one build slide is several steps there and one row here, so an index
       means two different things either side of the swap. Hence nav and goto
       stay local until a `flat` has arrived — this page will not drive a deck
       whose flattening it has not seen.

     · Every state carries the deck's `flat`, so adopting it is also how this
       page notices that the deck reloaded a re-ordered manifest. The flip side
       is that states arrive when nobody has touched anything, so a state that
       says nothing new — same flattening, same index — must change nothing on
       the page at all. Scroll position in the notes column is somebody's place
       in a paragraph they are reading out loud.
   ========================================================================== */

(function () {
  'use strict';

  var CHANNEL  = 'ai2026-deck';
  var HELLO_MS = 2000;     /* how often we call out while no deck has answered */
  var PING_MS  = 3500;     /* and once one has — just often enough to keep the
                              link light honest without ever going stale       */
  var STALE_MS = 5000;     /* no state for this long and we are not linked     */

  /* ---------------------------------------------------------- state ------ */

  var SLIDES = [];               // manifest slides
  var SECTIONS = Object.create(null);  // section id -> label
  var BY_ID = Object.create(null);     // slide id -> slide
  var NOTES = {};                // companion.json .slides, read through own()
  var FLAT = [];                 // [{ id, step }] — flattened steps, deck's or ours
  var flatSig = '';              // signature of FLAT: what makes one list another
  var fromDeck = false;          // is FLAT the deck's own, or our fallback?
  var mismatch = false;          // a deck is talking, about a manifest we lack
  var idToStep = Object.create(null);  // slide id -> first flattened index
  var rows = Object.create(null);      // slide id -> rail button
  var cur = 0;
  var shownId = null;            // the slide id render() last painted
  var lastState = null;          // the last state message the deck sent
  var lastStateAt = 0;
  var linked = false;
  var bus = null;

  var $ = function (sel) { return document.querySelector(sel); };
  var ui = {};

  /* Summary, sources and the decision record stay hidden until asked for.
     Module state rather than DOM state so a re-render keeps the choice. */
  var detailsOpen = false;
  function toggleDetails(force) {
    detailsOpen = force != null ? !!force : !detailsOpen;
    if (ui.blocks) ui.blocks.classList.toggle('is-details-open', detailsOpen);
    if (ui.details) ui.details.setAttribute('aria-pressed', detailsOpen ? 'true' : 'false');
  }

  /* Published for the smoke harness, and for a console poke during a talk. */
  window.companion = {
    get index() { return cur; },
    get count() { return FLAT.length; },
    get slideId() { return FLAT[cur] ? FLAT[cur].id : null; },
    get linked() { return linked; },
    get fromDeck() { return fromDeck; },
    get mismatch() { return mismatch; },
    ready: false
  };

  /* --------------------------------------------------------- helpers ----- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    /* Manifest and notes strings are content, never markup: everything that
       reaches the page goes through textContent. */
    if (text != null && text !== '') n.textContent = String(text);
    return n;
  }

  function has(v) { return typeof v === 'string' && v.trim() !== ''; }

  /* Own properties only. `'__proto__' in {}` is true and hands back
     Object.prototype, so a bare `in` turns any inherited name into a lookup
     that appears to succeed — and `Object.prototype | 0` is 0, i.e. slide one.
     Ids arrive from a JSON file and from another window; neither is trusted. */
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function slideAt(i) {
    var f = FLAT[i];
    return (f && f.id && own(BY_ID, f.id)) ? BY_ID[f.id] : null;
  }

  /* What makes one flattening a different flattening. Not its length: a
     renamed or re-ordered manifest flattens to exactly as many steps. */
  function signature(list) {
    return list.map(function (f) { return f.id + ':' + f.step; }).join('|');
  }

  /* --------------------------------------------------------- the wire ---- */

  function post(msg) {
    if (!bus) return;
    try { bus.postMessage(msg); } catch (e) {}
  }

  function hello() { post({ type: 'hello' }); }

  /* True only when this page knows the deck's own flattening and recognises
     the slides in it. Everything that moves the deck is gated on it. */
  function driving() { return fromDeck && !mismatch; }

  function onBusMessage(e) {
    var m = e && e.data;
    if (!m || m.type !== 'state') return;
    var flat = (Array.isArray(m.flat) && m.flat.length) ? m.flat : null;

    /* A state with no flattening in it tells us a position in a list we
       cannot see. Applying it against our stand-in list puts the wrong slide
       up while the light says linked — and taking the message as proof of
       life delays the hello that would fix it. So: ask, and stay put. */
    if (!flat && !fromDeck) { hello(); return; }

    lastState = m;
    lastStateAt = Date.now();
    if (!linked) { linked = true; paintStatus(); }

    var got = flat ? adoptFlat(flat) : 'same';
    if (got === 'rejected') return;      /* its index means nothing to us */

    var moved = (typeof m.index === 'number') ? setIndex(m.index) : false;
    if (got === 'adopted' && !moved) render();
  }

  /* The deck is the authority on the flattening; the moment it speaks, its
     list replaces ours. Three things this has to get right.

     · Same length is not the same deck. The test is the signature of the ids
       and their step numbers — a reordered manifest that happens to flatten to
       the same count used to leave this page on the wrong slide, for good,
       while still claiming to be linked.

     · A list is only useful if this page knows the slides in it. The deck's
       `?manifest=` override, or a junk message wearing the right type, can
       name slides that are not in our manifest at all; fewer than half of them
       resolving means the two windows are running different decks, and the
       honest move is to refuse the list, say so in the header, and keep
       driving ourselves.

     · Entries that do not resolve are kept, not filtered out. The deck's
       `index` is a position in this exact list: dropping an entry would shift
       every index after it and desync the two windows silently. An unknown
       entry renders as a missing-slide line instead.

     Across an adopted swap the page keeps showing the same SLIDE rather than
     the same number, for the reason in the header comment. */
  function adoptFlat(list) {
    var next = [];
    var resolved = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var id = String(f && f.id != null ? f.id : '');
      next.push({ id: id, step: (f && typeof f.step === 'number') ? f.step : null });
      if (id && own(BY_ID, id)) resolved++;
    }

    if (!next.length || resolved * 2 < next.length) {
      if (!mismatch) { mismatch = true; paintStatus(); }
      return 'rejected';
    }
    if (mismatch) { mismatch = false; paintStatus(); }

    var sig = signature(next);
    if (fromDeck && sig === flatSig) return 'same';

    var wasId = FLAT[cur] ? FLAT[cur].id : null;
    FLAT = next;
    flatSig = sig;
    fromDeck = true;
    indexFlat();
    buildRail();
    if (wasId && own(idToStep, wasId)) cur = idToStep[wasId];
    cur = Math.max(0, Math.min(FLAT.length - 1, cur));
    /* No render here: the caller renders once, knowing whether the index
       moved too, so an adoption costs one pass over the page and not two. */
    return 'adopted';
  }

  function indexFlat() {
    idToStep = Object.create(null);
    FLAT.forEach(function (f, i) {
      if (f.id && !own(idToStep, f.id)) idToStep[f.id] = i;
    });
  }

  /* One step per unparked slide. Wrong for a build slide — which owns a range
     — and that is the whole reason it is only a stand-in until the deck
     answers a hello, and the whole reason nothing is posted while it is up. */
  function fallbackFlat() {
    return SLIDES.filter(function (s) { return !s.parked; })
                 .map(function (s) { return { id: s.id, step: null }; });
  }

  /* The header carries the light and one word. The sentence that says what to
     do about it goes on its own line under the header, where it can be as long
     as it needs to be without squeezing the slide's section label out of the
     row it shares. */
  function paintStatus() {
    var word, hint;
    if (mismatch) {
      word = 'other deck';
      hint = 'The deck on the other screen is running a manifest this page does not have — ' +
             'its slides are not in this companion. Nothing here moves that deck.';
    } else if (linked) {
      word = 'linked';
      hint = '';
    } else {
      word = 'no deck';
      hint = 'No deck found. Open the presentation in another window and press c — ' +
             'or just drive the talk from this page.';
    }
    ui.status.dataset.linked = mismatch ? 'other' : (linked ? 'yes' : 'no');
    ui.statusText.textContent = word;
    ui.status.title = hint || 'Following the deck on the other screen.';
    ui.hint.textContent = hint;
    ui.hint.hidden = !hint;
  }

  /* Every HELLO_MS: age the link light, and call out.

     A deck speaks only when it renders, so silence is not absence — asking is
     the only way to know one is still there while nobody touches a key, and
     the answer is what keeps the light honest. Asking is free because a state
     that says nothing new now re-renders nothing; the idle answer used to
     rebuild the page and throw away the scroll position of the notes being
     read from. While no deck has answered at all we ask at the faster rate,
     so a deck opened after this page is picked up within two seconds. */
  function tick() {
    var now = Date.now();
    var fresh = (now - lastStateAt) < STALE_MS;
    if (fresh !== linked) { linked = fresh; paintStatus(); }
    if (now - lastStateAt > (fromDeck ? PING_MS : HELLO_MS)) hello();
  }

  /* ------------------------------------------------------- navigation ---- */

  /* The page keeps its own index so it is useful with no deck open at all.
     Moving it never speaks; the three callers below do that — and only once a
     deck has handed over its flattening, because until then our index counts
     something else and a goto would land the room on the wrong slide. A state
     arriving from the deck lands in setIndex too, and simply wins.

     Returns whether the index actually moved, so a caller that also changed
     the list can render exactly once. */
  function setIndex(i) {
    if (!FLAT.length) return false;
    var next = Math.max(0, Math.min(FLAT.length - 1, i | 0));
    if (next === cur) return false;
    cur = next;
    render();
    return true;
  }

  function nav(delta) {
    var d = delta > 0 ? 1 : -1;
    setIndex(cur + d);
    if (driving()) post({ type: 'nav', delta: d });
  }

  function gotoIndex(i) {
    setIndex(i);
    if (driving()) post({ type: 'goto', index: cur });
  }

  function gotoId(id) {
    if (own(idToStep, id)) setIndex(idToStep[id]);
    if (driving()) post({ type: 'goto', id: id });
  }

  /* ------------------------------------------------------------- rail ---- */

  function railLine(s) {
    return (has(s.display) && s.display) ||
           (has(s.body) && s.body) ||
           (has(s.caption) && s.caption) ||
           s.kind || '';
  }

  function buildRail() {
    rows = Object.create(null);
    clear(ui.railList);
    ui.railTotal.textContent = FLAT.length + ' steps';

    var frag = document.createDocumentFragment();
    var lastSection = null;
    var seen = Object.create(null);

    FLAT.forEach(function (f, i) {
      if (own(seen, f.id)) return;     // a build owns several steps, one row
      seen[f.id] = true;
      var s = (f.id && own(BY_ID, f.id)) ? BY_ID[f.id] : null;
      if (!s) return;

      if (s.section !== lastSection) {
        lastSection = s.section;
        frag.appendChild(el('div', 'rail-section',
          (own(SECTIONS, s.section) && SECTIONS[s.section]) || s.section || 'unsectioned'));
      }

      /* One row per slide, numbered with the step it JUMPS TO — a build's
         entry step, not its range. That is the number a click here puts in the
         counter, which is the only number the row has to agree with; the range
         it owns is on the row's tooltip rather than in the column, where three
         digits is all the width there is. */
      var span = 1;
      while (FLAT[i + span] && FLAT[i + span].id === f.id) span++;

      var b = el('button', 'rail-item');
      b.type = 'button';
      b.dataset.id = f.id;
      b.title = f.id + (span > 1
        ? ' · steps ' + pad(i + 1, 3) + '–' + pad(i + span, 3)
        : ' · step ' + pad(i + 1, 3));
      b.appendChild(el('span', 'n', pad(i + 1, 3)));
      b.appendChild(el('span', 'id', f.id));
      b.appendChild(el('span', 'line', railLine(s).slice(0, 120)));
      b.addEventListener('click', function () { gotoId(f.id); });
      rows[f.id] = b;
      frag.appendChild(b);
    });

    ui.railList.appendChild(frag);
  }

  /* `scrollTo` only when the SLIDE changed. Walking the steps of one build, or
     re-reading a state that says nothing new, must not yank the rail out from
     under the eye that is on it. */
  function paintRail(scrollTo) {
    var id = FLAT[cur] ? FLAT[cur].id : null;
    Object.keys(rows).forEach(function (k) {
      rows[k].classList.toggle('is-current', k === id);
    });
    if (!scrollTo) return;
    var row = (id && own(rows, id)) ? rows[id] : null;
    /* scroll-margin-top in companion.css keeps this clear of the sticky
       section header it would otherwise park underneath. */
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------ blocks --- */

  function block(cls, heading) {
    var sec = el('section', 'block ' + cls);
    sec.appendChild(el('h2', 'block-head', heading));
    var body = el('div', 'block-body');
    sec.appendChild(body);
    sec.__body = body;
    return sec;
  }

  function paragraphs(host, text) {
    String(text).split(/\n\s*\n/).forEach(function (p) {
      var t = p.replace(/\s*\n\s*/g, ' ').trim();
      if (t) host.appendChild(el('p', '', t));
    });
  }

  /* The script. companion.json notes are line-oriented; each line opens with
     a marker that says what kind of line it is:
         -  say this                 !  read this verbatim (a number, a quote)
         ?  the posed question       >  jump-off to a reading slide (R1–R7)
         ~  pocket: only if asked
     A line with no marker is a say line; blank lines are ignored. Notes with
     no marker on any line are legacy prose and fall back to paragraphs(). */
  var MARKS = { '-': 'say', '!': 'read', '?': 'ask', '>': 'jump', '~': 'pocket' };

  function scriptParse(text) {
    var out = [];
    String(text).split(/\n/).forEach(function (raw) {
      var l = raw.trim();
      if (!l) return;
      var m = /^([-!?>~])\s+(.*)$/.exec(l);
      out.push({ kind: m ? MARKS[m[1]] : 'say', mark: m ? m[1] : '', text: m ? m[2] : l });
    });
    return out;
  }

  function scriptList(text) {
    var items = scriptParse(text);
    if (!items.length || !items.some(function (i) { return i.mark; })) return null;
    var ul = el('ul', 'script');
    items.forEach(function (i) {
      var li = el('li', 'script-' + i.kind);
      li.appendChild(el('span', 'script-mark', i.mark === '-' ? '' : i.mark));
      li.appendChild(el('span', 'script-text', i.text));
      ul.appendChild(li);
    });
    return ul;
  }

  /* "What this slide points at" is prose in companion.json; it reads better
     as one bullet per sentence. The split is on sentence punctuation followed
     by a capital, digit or opening quote — except after the abbreviations
     citations are full of (v., et al., Fig., No., Mr, St., U.S., …), where the
     sentence keeps going. */
  var ABBR = /\b(?:v|vs|et al|fig|figs|no|nos|mr|mrs|ms|dr|hon|fmr|st|cf|e\.g|i\.e|pp|p|vol|art|arts|s|ss|ch|inc|ltd|co|corp|jr|sr|prof|approx|para|paras|cir|dist|supp|u\.s|d|m\.d|n\.d|s\.d|e\.d|w\.d|ed|eds|rev|univ|dept)\.$/i;

  /* A lone capital before the full stop is an initial (Katherine B. Forrest),
     never the end of a sentence. Case-sensitive on purpose. */
  var INITIAL = /(?:^|\s)[A-Z]\.$/;

  function sentences(text) {
    var out = [];
    String(text).split(/\n\s*\n/).forEach(function (para) {
      var flat = para.replace(/\s*\n\s*/g, ' ').trim();
      if (!flat) return;
      var buf = '';
      flat.split(/(?<=[.!?…][”’")\]]?)\s+(?=[“‘"(\[]?[A-Z0-9])/).forEach(function (piece) {
        buf = buf ? buf + ' ' + piece : piece;
        var tail = buf.replace(/[”’")\]]+$/, '');
        if (ABBR.test(tail) || INITIAL.test(tail)) return;
        out.push(buf); buf = '';
      });
      if (buf) out.push(buf);
    });
    return out;
  }

  function pointsList(text) {
    var items = sentences(text);
    if (!items.length) return null;
    var ul = el('ul', 'points');
    items.forEach(function (t) { ul.appendChild(el('li', '', t)); });
    return ul;
  }

  /* A build step's note, one <p> per line — a paragraph per line so that the
     last <p> in a .step-note is that step's last line (companion-smoke relies
     on it). */
  function scriptLines(host, text) {
    scriptParse(text).forEach(function (i) {
      host.appendChild(el('p', 'script-line script-' + i.kind, i.text));
    });
  }

  function refsList(refs) {
    var items = (Array.isArray(refs) ? refs : []).filter(function (r) { return r && has(r.text); });
    if (!items.length) return null;
    var ul = el('ul', 'refs');
    items.forEach(function (r) {
      var li = el('li');
      /* http(s) only, and set as a property rather than interpolated into
         markup — a notes file must not be able to become script. */
      if (has(r.url) && /^https?:\/\//i.test(r.url.trim())) {
        var a = el('a', '', r.text);
        a.href = r.url.trim();
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      } else {
        li.textContent = r.text;
      }
      ul.appendChild(li);
    });
    return ul;
  }

  /* Which step inside its build file this flattened position is, if any:
     the deck's number when the deck is the one talking, ours otherwise. */
  function buildInfo(s) {
    if (!s || s.kind !== 'build' || !s.build) return null;
    if (lastState && lastState.index === cur && lastState.build) return lastState.build;
    var f = FLAT[cur];
    if (!f || typeof f.step !== 'number') return null;
    return { step: f.step + 1, of: s.build.steps | 0 };
  }

  function stepKey(s) {
    if (!s || s.kind !== 'build') return null;
    var f = FLAT[cur];
    if (f && typeof f.step === 'number') return String(f.step);
    if (lastState && lastState.index === cur && lastState.build) return String(lastState.build.step - 1);
    return null;
  }

  /* -------------------------------------------------------------- render - */

  function render() {
    var f = FLAT[cur] || null;
    var id = f ? f.id : null;
    /* The one thing that licenses moving somebody's scroll position. */
    var changed = (id !== shownId);
    shownId = id;

    var s = slideAt(cur);
    if (!s) { renderMissing(id, changed); return; }

    var entry = (own(NOTES, s.id) && NOTES[s.id]) || null;
    var info = buildInfo(s);

    ui.counter.textContent = pad(cur + 1, 3) + ' / ' + pad(FLAT.length, 3);
    ui.section.textContent = (own(SECTIONS, s.section) && SECTIONS[s.section]) || s.section || '';
    ui.slug.textContent = (s.id || '') + '  ·  ' + (s.kind || '');
    if (info) {
      ui.buildStep.textContent = 'step ' + info.step + '/' + info.of;
      ui.buildStep.hidden = false;
    } else {
      ui.buildStep.textContent = '';
      ui.buildStep.hidden = true;
    }

    ui.display.textContent = has(s.display) ? s.display : '';
    ui.body.textContent = has(s.body) ? s.body : '';
    ui.caption.textContent = has(s.caption) ? s.caption : '';

    clear(ui.blocks);

    var note = entry && has(entry.notes) ? entry.notes : '';
    var summary = entry && has(entry.summary) ? entry.summary : '';
    var refs = refsList(entry && entry.refs);
    var sk = stepKey(s);
    var stepNote = (entry && entry.stepNotes && sk != null &&
                    own(entry.stepNotes, sk) && has(entry.stepNotes[sk]))
      ? entry.stepNotes[sk] : '';

    if (!note && !summary && !refs && !stepNote) {
      ui.blocks.appendChild(el('p', 'empty-note', 'no companion notes yet'));
    } else {
      if (note || stepNote) {
        var b1 = block('is-runthrough', 'Script');
        if (stepNote) {
          var sn = el('div', 'step-note');
          sn.appendChild(el('p', 'step-note-tag', 'step ' + (info ? info.step : (Number(sk) + 1))));
          scriptLines(sn, stepNote);
          b1.__body.appendChild(sn);
        }
        if (note) {
          var list = scriptList(note);
          if (list) b1.__body.appendChild(list); else paragraphs(b1.__body, note);
        }
        ui.blocks.appendChild(b1);
      }
      if (summary || refs) {
        var b2 = block('is-points-at is-detail', 'What this slide points at');
        if (summary) {
          var pl = pointsList(summary);
          if (pl) b2.__body.appendChild(pl); else paragraphs(b2.__body, summary);
        }
        if (refs) b2.__body.appendChild(refs);
        ui.blocks.appendChild(b2);
      }
    }
    ui.blocks.classList.toggle('is-details-open', detailsOpen);

    clear(ui.nextUp);
    var nextSlide = null;
    for (var i = cur + 1; i < FLAT.length; i++) {
      if (FLAT[i].id !== FLAT[cur].id) { nextSlide = slideAt(i); break; }
    }
    ui.nextUp.appendChild(el('span', 'tag', 'Next'));
    ui.nextUp.appendChild(document.createTextNode(
      nextSlide ? (has(nextSlide.display) ? nextSlide.display : (nextSlide.id || ''))
                : 'end of the deck'
    ));

    if (changed) ui.mainScroll.scrollTop = 0;
    paintRail(changed);
  }

  /* The deck can name a slide this page has never heard of: a `?manifest=`
     override on the other screen, or a list this page adopted with a few
     strangers in it. Say so. Leaving the previous slide's notes up is the one
     outcome that can get something wrong said out loud. */
  function renderMissing(id, changed) {
    ui.counter.textContent = pad(cur + 1, 3) + ' / ' + pad(FLAT.length, 3);
    ui.section.textContent = '';
    ui.slug.textContent = id || '—';
    ui.buildStep.textContent = '';
    ui.buildStep.hidden = true;

    ui.display.textContent = 'slide ' + (id || '(no id)') + ' is not in this companion’s manifest';
    ui.body.textContent = 'The deck on the other screen is showing something this page has no notes for.';
    ui.caption.textContent = '';

    clear(ui.blocks);
    clear(ui.nextUp);
    if (changed) ui.mainScroll.scrollTop = 0;
    paintRail(changed);
  }

  /* --------------------------------------------------------------- keys -- */

  /* The page has no text inputs today, so this guard never fires. It is two
     lines, and the first thing anyone adds here — a search box over the rail —
     would otherwise silently eat every typed space as "next step". */
  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (isTyping(e)) return;
    var k = e.key;
    if (k === 'ArrowRight' || k === ' ' || k === 'Spacebar' || k === 'PageDown') { nav(1); e.preventDefault(); return; }
    if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { nav(-1); e.preventDefault(); return; }
    if (k === 'Home') { gotoIndex(0); e.preventDefault(); return; }
    if (k === 'End') { gotoIndex(FLAT.length - 1); e.preventDefault(); return; }
    if (k === 'd' || k === 'D') { toggleDetails(); e.preventDefault(); return; }
  }

  /* --------------------------------------------------------------- boot -- */

  function start(manifest, notes) {
    var meta = manifest.meta || {};
    (meta.sections || []).forEach(function (sec) { SECTIONS[sec.id] = sec.label; });
    (manifest.slides || []).forEach(function (s) {
      SLIDES.push(s);
      if (s && s.id && !own(BY_ID, s.id)) BY_ID[s.id] = s;
    });
    NOTES = (notes && notes.slides) || {};

    FLAT = fallbackFlat();
    flatSig = signature(FLAT);
    indexFlat();
    buildRail();
    render();

    window.companion.ready = true;

    /* Announce immediately; a deck already up answers on the next turn. */
    hello();
    setInterval(tick, HELLO_MS);
  }

  function fail(msg) {
    clear(ui.blocks);
    ui.display.textContent = msg;
    window.companion.ready = true;
  }

  function init() {
    ui = {
      railList: $('#rail-list'),
      railTotal: $('#rail-total'),
      counter: $('#counter'),
      section: $('#section'),
      slug: $('#slug'),
      buildStep: $('#buildstep'),
      status: $('#link-status'),
      statusText: $('#link-text'),
      hint: $('#link-hint'),
      display: $('#display'),
      body: $('#body'),
      caption: $('#caption'),
      blocks: $('#blocks'),
      details: $('#btn-details'),
      nextUp: $('#next-up'),
      mainScroll: $('#main-scroll')
    };

    paintStatus();

    $('#btn-next').addEventListener('click', function () { nav(1); });
    if (ui.details) ui.details.addEventListener('click', function () { toggleDetails(); });
    $('#btn-prev').addEventListener('click', function () { nav(-1); });
    window.addEventListener('keydown', onKey);

    if (typeof BroadcastChannel === 'function') {
      try {
        bus = new BroadcastChannel(CHANNEL);
        bus.onmessage = onBusMessage;
      } catch (e) { bus = null; }
    }

    var json = function (url) {
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error(url + ' ' + r.status);
        return r.json();
      });
    };

    /* The manifest is required; the notes file is not — a missing or broken
       companion.json leaves every slide on the "no companion notes yet" path
       rather than taking the page down with it. */
    Promise.all([
      json('slides.json'),
      json('companion.json').catch(function () { return { slides: {} }; })
    ]).then(function (r) { start(r[0], r[1]); })
      .catch(function (err) { fail('The slide manifest did not load: ' + err.message); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
