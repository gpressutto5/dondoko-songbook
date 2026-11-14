// Dondoko Songbook — song browser for Taiko no Tatsujin: Rhythm Festival
import { I18N, GENRES, COURSES } from './i18n.js';
import { findPreview, forgetPreview, setBaked } from './preview.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('dsb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dsb:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/** Loose text folding for search: width/case/accents/kana-insensitive. */
export const fold = (s) => (s || '')
  .normalize('NFKC').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[\s\u3000・･.,!?'"`~〜\-‐–—:;/()[\]「」『』【】♪☆★♡♥]/g, '');

/**
 * Spelling-insensitive key for romaji: "shiruetto" = "siruetto", "shounen" = "shonen" = "shōnen".
 * Lossy on purpose; only ever compared with other romaKey() output.
 */
export const romaKey = (s) => fold(s)
  .replace(/[^a-z0-9|]/g, '')
  .replace(/sh/g, 's').replace(/ch|ts/g, 't').replace(/dz|j/g, 'z').replace(/f/g, 'h').replace(/l/g, 'r')
  .replace(/([stzkgnhbpmr])y(?=[aou])/g, '$1').replace(/m(?=[bp])/g, 'n')
  .replace(/wa/g, 'ha').replace(/wo/g, 'o')  // particles: は is typed "wa", を "o"
  .replace(/ou|oh(?![aiueo])/g, 'o').replace(/([aiueo])\1+/g, '$1');

const saved = store.get('settings', {});
const state = {
  q: '', genre: 'all', src: new Set(), platform: 'all', pack: '', levels: new Set(), ura: false, fav: false, isNew: false,
  sort: 'default', sel: null,
  titles: saved.v === 2 && saved.titles === 'jp' ? 'jp' : 'en',
  autoplay: saved.autoplay ?? true,
  sfx: saved.sfx ?? true,
  volume: saved.volume ?? 0.8,
};
const favs = new Set(store.get('favs', []));
const t = (k, vars) => {
  let s = I18N[k] ?? k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.replaceAll(`{${a}}`, b);
  return s;
};
const saveSettings = () => store.set('settings', { v: 2, titles: state.titles, autoplay: state.autoplay, sfx: state.sfx, volume: state.volume });

let DATA = null;
let SONGS = [];
let PACKS = [];
const nodes = new Map();        // song id -> <li>
let visible = [];               // songs currently listed, in order

const els = {
  list: $('#list'), empty: $('#empty'), count: $('#count'), countLabel: $('#count-label'), q: $('#q'),
  genres: $('#genres'), detail: Object.assign(document.createElement('div'), { id: 'detail', className: 'detail' }),
  audio: $('#audio'), clear: $('#btn-clear'), topbar: $('#topbar'),
  filters: $('#filters'), btnFilters: $('#btn-filters'), badge: $('#filters-badge'),
  pack: $('#sel-pack'), sort: $('#sel-sort'), laneNotes: $('#lane-notes'), brandDrum: $('.brand-drum'),
};

// ------------------------------------------------------------------ helpers
const oni = (s) => (s.lv ? s.lv[3] || 0 : 0);
const ura = (s) => (s.lv ? s.lv[4] || 0 : 0);
const maxBpm = (s) => (s.bpm ? s.bpm[s.bpm.length - 1] : 0);
const mainTitle = (s) => (state.titles === 'en' && s.e ? s.e : s.t);
const altTitle = (s) => (state.titles === 'en' && s.e ? s.t : s.e || '');
const en = () => state.titles === 'en';
const artistLine = (s) => (en() && s.ae ? s.ae : s.a ? s.a.join(', ') : s.s ? '' : s.ae || '');
const subText = (s) => (en() && s.se ? s.se : s.s || '');
const creditNames = (s) => (en() && s.ae ? s.ae.split(/,\s*/) : s.a || []).map(fold).filter(Boolean);
/** The official subtitle, unless it only repeats the artist credits (or the other way round). */
const noteOf = (s) => {
  const text = subText(s);
  if (!text) return '';
  const sub = fold(text), names = creditNames(s);
  if (names.length && names.every((n) => sub.includes(n))) return '';
  return fold(artistLine(s)).includes(sub) ? '' : text;
};
const creditOf = (s) => {
  const a = artistLine(s), text = subText(s);
  if (!text || !a) return a;
  const sub = fold(text), names = creditNames(s);
  return names.every((n) => sub.includes(n)) ? text : a;
};
const subLine = (s) => [creditOf(s), noteOf(s)].filter(Boolean).join(' ・ ');
const packName = (p) => (state.titles === 'en' && p.en ? p.en : p.name);
const genreOf = (id) => GENRES.find((g) => g.id === id) || GENRES[GENRES.length - 1];
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d || 1).toLocaleDateString('en-US', d ? { year: 'numeric', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'long' });
};
const packOn = (p, plat) => plat === 'all' || p.platform === 'all' || p.platform === plat;

/** Which sources ("base" | "pass" | "dlc") offer this song on the chosen platform. */
function sourcesOf(s, plat = state.platform) {
  const out = [];
  if (s.b && (plat === 'all' || s.b.includes(plat))) out.push('base');
  if (s.p && !(s.sw && plat === 'other')) out.push('pass');
  if (s.d && s.d.some((id) => packOn(PACKS[id], plat))) out.push('dlc');
  return out;
}

// ------------------------------------------------------------------ sfx (tiny synthesized don / ka)
let actx = null;
function hit(kind = 'don') {
  els.brandDrum.classList.remove('hit'); void els.brandDrum.getBoundingClientRect(); els.brandDrum.classList.add('hit');
  if (!state.sfx) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const now = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    if (kind === 'don') {
      o.type = 'sine'; o.frequency.setValueAtTime(170, now); o.frequency.exponentialRampToValueAtTime(52, now + 0.13);
      g.gain.setValueAtTime(0.45, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    } else {
      o.type = 'triangle'; o.frequency.setValueAtTime(1150, now); o.frequency.exponentialRampToValueAtTime(620, now + 0.05);
      g.gain.setValueAtTime(0.16, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    }
    o.connect(g).connect(actx.destination); o.start(now); o.stop(now + 0.26);
  } catch { /* audio not available */ }
}

// ------------------------------------------------------------------ filtering + list
function matches(s) {
  if (state.genre !== 'all' && s.g !== state.genre) return false;
  const src = sourcesOf(s);
  if (!src.length) return false;
  if (state.src.size && !src.some((x) => state.src.has(x))) return false;
  if (state.pack !== '' && !(s.d && s.d.includes(+state.pack))) return false;
  if (state.levels.size && !(state.levels.has(oni(s)) || state.levels.has(ura(s)))) return false;
  if (state.ura && !ura(s)) return false;
  if (state.fav && !favs.has(s.key)) return false;
  if (state.isNew && !s.n) return false;
  if (state.q) {
    for (const term of state.q.split(/\s+/)) {
      const f = fold(term);
      if (!f || s.hay.includes(f)) continue;
      const r = romaKey(term);
      if (!r || !s.rom.includes(r)) return false;
    }
  }
  return true;
}

const SORTS = {
  default: (a, b) => a.id - b.id,
  title: (a, b) => (state.titles === 'en' ? mainTitle(a).localeCompare(mainTitle(b), 'en', { sensitivity: 'base' }) : (a.k || a.t).localeCompare(b.k || b.t, 'ja')),
  hard: (a, b) => Math.max(oni(b), ura(b)) - Math.max(oni(a), ura(a)) || maxBpm(b) - maxBpm(a),
  easy: (a, b) => (oni(a) || 99) - (oni(b) || 99) || (maxBpm(a) || 999) - (maxBpm(b) || 999),
  fast: (a, b) => maxBpm(b) - maxBpm(a),
  slow: (a, b) => (maxBpm(a) || 9999) - (maxBpm(b) || 9999),
  recent: (a, b) => (b.date || '').localeCompare(a.date || '') || a.id - b.id,
};

const activeFilterCount = () => (state.genre !== 'all') + state.src.size + (state.platform !== 'all') + (state.pack !== '') + state.levels.size + state.ura + state.fav + state.isNew;

function apply({ keepScroll = false } = {}) {
  visible = SONGS.filter(matches).sort(SORTS[state.sort]);
  if (state.sel != null && !visible.includes(SONGS[state.sel])) deselect();
  els.list.replaceChildren(...visible.map((s) => nodes.get(s.id)));
  els.empty.hidden = visible.length > 0;
  if (els.count.textContent !== String(visible.length)) {
    els.count.textContent = visible.length;
    els.count.classList.remove('bump'); void els.count.offsetWidth; els.count.classList.add('bump');
  }
  els.countLabel.textContent = t(visible.length === 1 ? 'song' : 'songs');
  const n = activeFilterCount();
  els.badge.hidden = !n; els.badge.textContent = n;
  els.clear.hidden = !(n || state.q || state.genre !== 'all');
  document.body.className = 'g-' + state.genre;
  if (!keepScroll) {
    // jump back to the start of the results when the list changed under a scrolled-down view
    const top = els.list.getBoundingClientRect().top + scrollY - els.topbar.offsetHeight - 24;
    if (scrollY > top) scrollTo({ top: Math.max(0, top) });
  }
}

function fillBar(li, s) {
  const src = sourcesOf(s, 'all');
  const o = oni(s), u = ura(s);
  li.firstChild.innerHTML = `
    <span class="bar-main"><span class="bar-title">${esc(mainTitle(s))}</span><span class="bar-sub">${esc(subLine(s) || altTitle(s))}</span></span>
    <span class="bar-tags">${favs.has(s.key) ? '<i class="tag fav">♥</i>' : ''}${s.n ? '<i class="tag new">NEW</i>' : ''}${src.includes('base') ? '<i class="tag base">BASE</i>' : ''}${src.includes('pass') ? '<i class="tag pass">PASS</i>' : ''}${src.includes('dlc') ? '<i class="tag dlc">DLC</i>' : ''}</span>
    <span class="bar-lv">${o ? `<b class="lv" title="Oni ★${o}">${o}</b>` : '<b class="lv none">–</b>'}${u ? `<b class="lv ura" title="Ura ★${u}">${u}</b>` : ''}</span>`;
}

function buildList() {
  for (const s of SONGS) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = `bar g-${s.g}`; b.dataset.id = s.id;
    li.append(b);
    fillBar(li, s);
    nodes.set(s.id, li);
  }
}
const refreshBars = () => { for (const s of SONGS) fillBar(nodes.get(s.id), s); markSelected(); };

// ------------------------------------------------------------------ controls
function chip(parent, { label, cls = '', on, toggle }) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `chip ${cls}`; b.innerHTML = label;
  const paint = () => { b.classList.toggle('on', on()); b.setAttribute('aria-pressed', on()); };
  b.addEventListener('click', () => { toggle(); hit('ka'); paintControls(); apply(); });
  b._paint = paint; paint();
  parent.append(b);
}
const paintControls = () => { $$('.chip').forEach((c) => c._paint?.()); $$('.genre-tab').forEach((g) => { const on = g.dataset.g === state.genre; g.classList.toggle('on', on); g.setAttribute('aria-selected', on); }); els.pack.value = state.pack; els.sort.value = state.sort; };

function buildControls() {
  // genres
  const counts = {};
  for (const s of SONGS) counts[s.g] = (counts[s.g] || 0) + 1;
  const tabs = [{ id: 'all', jp: 'すべて', n: SONGS.length }, ...GENRES.filter((g) => counts[g.id]).map((g) => ({ ...g, n: counts[g.id] }))];
  els.genres.replaceChildren(...tabs.map((g) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `genre-tab g-${g.id}`; b.dataset.g = g.id; b.setAttribute('role', 'tab');
    b.innerHTML = `<span class="gt-name">${esc(g.id === 'all' ? t('all') : g.short || g.en)}</span><span class="gt-meta"><i>${esc(g.jp)} · </i>${g.n}</span>`;
    b.addEventListener('click', () => { state.genre = g.id; hit('don'); paintControls(); apply(); });
    return b;
  }));

  const src = $('#chips-src'); src.replaceChildren();
  for (const k of ['base', 'pass', 'dlc']) chip(src, { label: `${t('src_' + k)} <small>${DATA.counts[k === 'pass' ? 'music_pass' : k]}</small>`, cls: 'c-' + k, on: () => state.src.has(k), toggle: () => (state.src.has(k) ? state.src.delete(k) : state.src.add(k)) });

  const plat = $('#chips-platform'); plat.replaceChildren();
  for (const k of ['all', 'switch', 'other']) chip(plat, { label: t('plat_' + k), on: () => state.platform === k, toggle: () => { state.platform = k; } });

  els.pack.replaceChildren(new Option(t('allPacks'), ''), ...[...PACKS].sort((a, b) => b.date.localeCompare(a.date)).map((p) => new Option(`${packName(p)} (${p.count})`, p.id)));

  const lv = $('#chips-level'); lv.replaceChildren();
  for (let i = 1; i <= 10; i++) chip(lv, { label: `★${i}`, on: () => state.levels.has(i), toggle: () => (state.levels.has(i) ? state.levels.delete(i) : state.levels.add(i)) });

  const extra = $('#chips-extra'); extra.replaceChildren();
  chip(extra, { label: t('fUra'), on: () => state.ura, toggle: () => { state.ura = !state.ura; } });
  chip(extra, { label: t('fNew'), on: () => state.isNew, toggle: () => { state.isNew = !state.isNew; } });
  chip(extra, { label: '♥ ' + t('fFav'), on: () => state.fav, toggle: () => { state.fav = !state.fav; } });

  els.sort.replaceChildren(...Object.keys(SORTS).map((k) => new Option(t('sort_' + k), k)));
  paintControls();
}

function applyI18n() {
  $$('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((e) => { e.placeholder = t(e.dataset.i18nPh); });
  $$('[data-i18n-html]').forEach((e) => { e.innerHTML = t(e.dataset.i18nHtml, { date: fmtDate(DATA?.generated) }); });
  $$('[data-i18n-aria]').forEach((e) => { e.setAttribute('aria-label', t(e.dataset.i18nAria)); });
  $$('#seg-titles button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.titles));
  for (const [id, key] of [['tg-autoplay', 'autoplay'], ['tg-sfx', 'sfx']]) { const b = $('#' + id); b.classList.toggle('on', state[key]); b.setAttribute('aria-pressed', state[key]); }
}

// ------------------------------------------------------------------ selection + detail
const DRUM_SVG = `<svg class="drum" viewBox="0 0 120 120" aria-hidden="true"><ellipse cx="60" cy="110" rx="46" ry="7" fill="rgba(42,18,6,.3)"/><rect x="12" y="24" width="96" height="80" rx="32" fill="#b5441c" stroke="#2a1206" stroke-width="6"/><rect x="15" y="44" width="90" height="40" fill="#d85a24"/><path d="M13 46h94M13 82h94" stroke="#2a1206" stroke-width="5"/><g fill="#ffd23f" stroke="#2a1206" stroke-width="2.5"><circle cx="26" cy="64" r="4.5"/><circle cx="43" cy="64" r="4.5"/><circle cx="60" cy="64" r="4.5"/><circle cx="77" cy="64" r="4.5"/><circle cx="94" cy="64" r="4.5"/></g><ellipse cx="60" cy="28" rx="48" ry="18" fill="#fff6e0" stroke="#2a1206" stroke-width="6"/><ellipse cx="60" cy="28" rx="28" ry="9.5" fill="#f2452b" stroke="#2a1206" stroke-width="4"/></svg>`;
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M5.5 4.5h4.5v15H5.5zM14 4.5h4.5v15H14z"/></svg>';

const player = { id: null, status: 'idle', pv: null, token: 0 };
const selected = () => (state.sel == null ? null : SONGS[state.sel]);

function markSelected() {
  $$('.bar.sel').forEach((b) => { b.classList.remove('sel', 'playing'); b.setAttribute('aria-expanded', 'false'); b.parentNode.classList.remove('open'); });
  const s = selected();
  if (!s) return;
  const b = nodes.get(s.id).firstChild;
  b.classList.add('sel'); b.setAttribute('aria-expanded', 'true'); b.parentNode.classList.add('open');
  b.classList.toggle('playing', player.id === s.id && player.status === 'playing');
}

/** Close the open song (its panel folds away and the preview stops). */
function deselect() {
  if (state.sel == null) return;
  clearTimeout(previewTimer);
  stopAudio();
  state.sel = null; player.id = null; player.pv = null; player.status = 'idle';
  markSelected();
  renderDetail();
  history.replaceState(null, '', location.pathname + location.search);
}

let previewTimer = 0;
/** Open a song: its bar unfolds into the details + player, like the game's song select. */
function select(id, { play = state.autoplay, scroll = false, sound = true } = {}) {
  if (state.sel === id) return;
  const li = nodes.get(id);
  const before = li.getBoundingClientRect().top;
  state.sel = id;
  const s = selected();
  if (sound) hit('don');
  stopAudio();
  player.id = id; player.pv = null; player.status = 'idle';
  markSelected();
  renderDetail();
  history.replaceState(null, '', '#' + encodeURIComponent(s.key));
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => loadPreview(s, play), play ? 320 : 120);
  if (scroll === 'center') {
    // far-away rows are size-estimated (content-visibility), so settle over a couple of frames
    const go = () => li.scrollIntoView({ block: 'start' });
    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
    return;
  }
  // the previously open panel may have folded away above us: keep the clicked bar where it was,
  // then nudge the page just enough to show the whole unfolded panel below the sticky search bar
  const top = li.getBoundingClientRect().top;
  const min = els.topbar.getBoundingClientRect().bottom + 16, max = innerHeight - 20;
  let want = before;
  if (want + li.offsetHeight > max) want = max - li.offsetHeight;
  if (want < min) want = min;
  scrollBy({ top: top - want, behavior: 'instant' });
}

function courseHtml(s) {
  const lv = s.lv || [];
  return COURSES.filter((c, i) => i < 4 || lv[4]).map((c, i) => {
    const v = lv[i] || 0;
    return `<div class="course c-${c.id}"><span class="c-name">${c.jp}<small>${esc(c.en)}</small></span><span class="c-lv ${v ? '' : 'na'}">${v || '?'}</span><span class="c-stars">${Array.from({ length: 10 }, (_, k) => `<i class="${k < v ? 'f' : ''}"></i>`).join('')}</span></div>`;
  }).join('');
}

function whereHtml(s) {
  const rows = [];
  if (s.b) {
    const note = s.b.length === 2 ? t('platBoth') : s.b[0] === 'switch' ? t('onlySwitch') : t('onlyOther');
    rows.push(`<li><i class="tag base">BASE</i><span>${t('whereBase')}<small>${note}</small></span></li>`);
  }
  if (s.p) {
    const bits = [t('wherePassNote')];
    if (s.pd) bits.push(t('passSince', { date: fmtDate(s.pd) }));
    if (s.n) bits.push('NEW');
    if (s.sw) bits.push(t('onlySwitch'));
    rows.push(`<li><i class="tag pass">PASS</i><span>Taiko Music Pass<small>${bits.join(' · ')}</small></span></li>`);
  }
  for (const id of s.d || []) {
    const p = PACKS[id];
    const bits = [fmtDate(p.date)];
    if (p.price) bits.push(`¥${p.price.toLocaleString('ja-JP')} ${t('plusTax')}`);
    if (p.single) bits.push(t('single'));
    if (p.platform === 'switch') bits.push(t('onlySwitch'));
    if (p.platform === 'other') bits.push(t('onlyOther'));
    if (p.discontinued) bits.push(t('discontinued'));
    rows.push(`<li><i class="tag dlc">DLC</i><span><button type="button" class="pack-link" data-pack="${p.id}" title="${esc(t('filterPack'))}">${esc(packName(p))}</button><small>${bits.join(' · ')}</small></span></li>`);
  }
  return rows.join('');
}

function renderDetail() {
  const s = selected();
  const d = els.detail;
  if (!s) { d.remove(); d.innerHTML = ''; return; }
  const bpm = s.bpm ? (s.bpm.length > 1 ? `${s.bpm[0]}–${s.bpm[1]}` : s.bpm[0]) : null;
  let beat = maxBpm(s) || 120;
  while (beat > 200) beat /= 2;
  while (beat < 75) beat *= 2;
  d.className = `detail g-${s.g}`;
  d.style.setProperty('--beat', (60 / beat).toFixed(3) + 's');
  const alt = altTitle(s), artist = creditOf(s), note = noteOf(s);
  d.innerHTML = `
    <div class="stage">
      <div class="jacket" id="jacket">♪</div>
      ${bpm ? `<span class="bpm">BPM ${bpm}</span>` : ''}
      <div class="sticks"><span class="stick l"></span><span class="stick r"></span></div>
      ${DRUM_SVG}
    </div>
    <div class="d-body">
      <div class="d-head">
        <div class="d-info">
          ${alt ? `<p class="d-alt">${esc(alt)}</p>` : ''}
          ${s.k && state.titles === 'jp' ? `<p class="d-kana">${esc(s.k)}</p>` : ''}
          ${artist ? `<p class="d-artist">${esc(artist)}</p>` : ''}
          ${note && !(state.titles === 'en' && s.x) ? `<p class="d-note">${esc(note)}</p>` : ''}
          ${s.x ? `<p class="d-note">${esc(s.x)}</p>` : ''}
        </div>
        <button type="button" class="icon-btn ${favs.has(s.key) ? 'on' : ''}" data-act="fav" aria-pressed="${favs.has(s.key)}" aria-label="${esc(t('favorite'))}" title="${esc(t('favorite'))}">♥</button>
        <button type="button" class="icon-btn close" data-act="close" aria-label="${esc(t('collapse'))}" title="${esc(t('collapse'))}">✕</button>
      </div>
      <div class="player">
        <button type="button" class="play-btn" data-act="play" aria-label="${esc(t('play'))}">${ICON_PLAY}</button>
        <div class="p-track" data-act="seek"><div class="p-fill" style="width: 0"></div></div>
        <div class="p-row"><span class="p-status"></span><span class="p-time"></span>
          <input class="p-vol" type="range" min="0" max="1" step="0.05" value="${state.volume}" aria-label="${esc(t('volume'))}"></div>
      </div>
      <div class="d-cols">
        <div><h3 class="d-h">${t('difficulty')}</h3><div class="courses">${courseHtml(s)}</div></div>
        <div><h3 class="d-h">${t('where')}</h3><ul class="where">${whereHtml(s)}</ul></div>
      </div>
      <div class="links" id="links"></div>
    </div>`;
  nodes.get(s.id).append(d);
  paintPlayer();
}

function paintPlayer() {
  const s = selected();
  if (!s) return;
  const d = els.detail;
  const mine = player.id === s.id;
  const st = mine ? player.status : 'idle';
  const playing = st === 'playing';
  d.classList.toggle('playing', playing);
  $$('.play-btn', d).forEach((b) => {
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    b.classList.toggle('loading', st === 'loading');
    b.disabled = st === 'none';
    b.setAttribute('aria-label', t(playing ? 'pause' : 'play'));
  });
  const pv = mine ? player.pv : null;
  const status = $('.p-status', d);
  if (status) {
    status.innerHTML = st === 'loading' ? t('pvLoading')
      : st === 'none' ? t('pvNone')
      : st === 'error' ? t('pvError')
      : pv ? `♪ ${esc(pv.n)} — ${esc(pv.a)}`
      : t('pvIdle');
    status.title = pv ? `${pv.n} — ${pv.a}` : '';
  }
  const jacket = $('#jacket', d);
  if (jacket) {
    jacket.classList.toggle('has-art', !!pv?.i);
    jacket.style.backgroundImage = pv?.i ? `url("${pv.i.replace('100x100', '300x300')}")` : '';
  }
  const links = $('#links', d);
  if (links) {
    const yt = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`太鼓の達人 ${s.t}`);
    links.innerHTML = `${pv?.l ? `<a href="${esc(pv.l)}" target="_blank" rel="noopener">Apple Music ↗</a>` : ''}
      <a href="${yt}" target="_blank" rel="noopener">${t('ytSearch')} ↗</a>
      ${s.w ? `<a href="https://taiko.wiki/song/${esc(s.w)}" target="_blank" rel="noopener">${t('chart')} ↗</a>` : ''}`;
  }
  markSelected();
  paintProgress();
}

function paintProgress() {
  const fill = $('.p-fill', els.detail), time = $('.p-time', els.detail);
  if (!fill) return;
  const a = els.audio;
  const on = player.id === state.sel && a.duration > 0 && (player.status === 'playing' || player.status === 'ready');
  fill.style.width = on ? `${(a.currentTime / a.duration) * 100}%` : '0';
  const mm = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  time.textContent = on ? `${mm(a.currentTime)} / ${mm(a.duration)}` : '';
}

// ------------------------------------------------------------------ audio preview
function stopAudio() {
  player.token++;
  els.audio.pause();
  els.audio.removeAttribute('src');
}

async function loadPreview(s, play, { force = false } = {}) {
  const token = ++player.token;
  player.id = s.id; player.status = 'loading'; player.pv = null; player.wantPlay = false;
  paintPlayer();
  let pv = null;
  try { pv = await findPreview(s, { force }); } catch { pv = undefined; }
  if (token !== player.token) return;
  if (!pv) { player.status = pv === undefined ? 'error' : 'none'; paintPlayer(); return; }
  player.pv = pv; player.status = 'ready';
  els.audio.src = pv.u; els.audio.volume = state.volume;
  paintPlayer();
  if (play || player.wantPlay) startAudio();
}

async function startAudio() {
  try { await els.audio.play(); } catch (e) { if (e.name !== 'AbortError') { player.status = 'ready'; paintPlayer(); } }
}

function togglePlay() {
  const s = selected();
  if (!s) return;
  if (player.id !== s.id || player.status === 'idle' || player.status === 'error') { clearTimeout(previewTimer); loadPreview(s, true); return; }
  if (player.status === 'loading') { player.wantPlay = true; return; }
  if (player.status === 'none') return;
  if (els.audio.paused) startAudio(); else els.audio.pause();
}

els.audio.addEventListener('playing', () => { player.status = 'playing'; paintPlayer(); });
els.audio.addEventListener('pause', () => { if (player.status === 'playing') { player.status = 'ready'; paintPlayer(); } });
els.audio.loop = true;  // like the game's song select, the preview keeps looping until you move on
els.audio.addEventListener('timeupdate', paintProgress);
els.audio.addEventListener('error', () => {
  const s = selected();
  if (!s || player.id !== s.id || !els.audio.getAttribute('src')) return;
  if (player.retried !== s.id) { player.retried = s.id; forgetPreview(s); loadPreview(s, true, { force: true }); } else { player.status = 'none'; paintPlayer(); }
});

// ------------------------------------------------------------------ note lane decoration
let laneTimer = 0, beatCount = 0;
function spawnNote() {
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const playing = player.status === 'playing';
  if (!playing && Math.random() < 0.45) return;
  const n = document.createElement('span');
  const big = Math.random() < 0.12;
  n.className = `note ${Math.random() < 0.42 ? 'ka' : ''} ${big ? 'big' : ''}`;
  n.style.animationDuration = `${Math.max(4, innerWidth / 260)}s`;
  n.addEventListener('animationend', () => n.remove());
  els.laneNotes.append(n);
}
function laneLoop() {
  clearTimeout(laneTimer);
  const s = selected();
  let gap = 620;
  if (player.status === 'playing' && s) { let b = maxBpm(s) || 120; while (b > 200) b /= 2; while (b < 75) b *= 2; gap = 60000 / b; if (++beatCount % 8 === 7) gap *= 2; }
  spawnNote();
  if (player.status === 'playing') { const tg = $('.lane-target'); tg.classList.remove('hit'); void tg.offsetWidth; tg.classList.add('hit'); }
  laneTimer = setTimeout(laneLoop, gap);
}

// ------------------------------------------------------------------ events
function clearFilters() {
  Object.assign(state, { q: '', genre: 'all', platform: 'all', pack: '', ura: false, fav: false, isNew: false });
  state.src.clear(); state.levels.clear(); els.q.value = '';
  paintControls(); apply();
}

function move(delta) {
  if (!visible.length) return;
  let i = visible.findIndex((s) => s.id === state.sel);
  i = i < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, i + delta));
  select(visible[i].id, { scroll: true });
  nodes.get(visible[i].id).firstChild.focus({ preventScroll: true });
}

function toggleFav() {
  const s = selected();
  if (!s) return;
  favs.has(s.key) ? favs.delete(s.key) : favs.add(s.key);
  store.set('favs', [...favs]);
  hit('ka');
  fillBar(nodes.get(s.id), s);
  const b = $('[data-act="fav"]', els.detail);
  b?.classList.toggle('on', favs.has(s.key)); b?.setAttribute('aria-pressed', favs.has(s.key));
  markSelected();
  if (state.fav) apply({ keepScroll: true });
}

function bind() {
  let qTimer = 0;
  els.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = els.q.value.trim(); apply(); }, 90); });
  els.list.addEventListener('click', (e) => {
    const b = e.target.closest('.bar');
    if (!b) return;
    if (+b.dataset.id === state.sel) { hit('ka'); deselect(); } else select(+b.dataset.id);
  });
  els.clear.addEventListener('click', clearFilters);
  els.btnFilters.addEventListener('click', () => { const open = els.filters.classList.toggle('open'); els.btnFilters.setAttribute('aria-expanded', open); hit('ka'); });
  // the sticky search bar's height feeds the sidebar offset and scroll margins
  new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', els.topbar.offsetHeight + 'px')).observe(els.topbar);
  els.pack.addEventListener('change', () => { state.pack = els.pack.value; apply(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value; apply(); });

  $('#seg-titles').addEventListener('click', (e) => { const v = e.target.dataset?.v; if (!v) return; state.titles = v; saveSettings(); applyI18n(); buildControls(); refreshBars(); apply({ keepScroll: true }); renderDetail(); });
  $('#tg-autoplay').addEventListener('click', () => { state.autoplay = !state.autoplay; saveSettings(); applyI18n(); });
  $('#tg-sfx').addEventListener('click', () => { state.sfx = !state.sfx; saveSettings(); applyI18n(); hit('don'); });

  els.detail.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') { togglePlay(); return; }
    if (act === 'fav') { toggleFav(); return; }
    if (act === 'close') { hit('ka'); deselect(); return; }
    if (act === 'seek') {
      const tr = e.target.closest('.p-track'), a = els.audio;
      if (a.duration > 0 && player.id === state.sel) { const r = tr.getBoundingClientRect(); a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration; }
      return;
    }
    const pack = e.target.closest('.pack-link');
    if (pack) {
      const keep = state.sel;
      clearFilters(); state.pack = pack.dataset.pack; paintControls(); apply();
      if (keep != null && state.sel == null && visible.includes(SONGS[keep])) select(keep, { play: false, sound: false });
      return;
    }
  });
  els.detail.addEventListener('input', (e) => { if (e.target.classList.contains('p-vol')) { state.volume = +e.target.value; els.audio.volume = state.volume; saveSettings(); } });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (typing) {
      if (e.key === 'Escape') { if (e.target === els.q && els.q.value) { els.q.value = ''; state.q = ''; apply(); } e.target.blur(); }
      else if (e.target === els.q && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); els.q.blur(); if (e.key === 'Enter' && visible.length) select(visible[0].id, { scroll: true }); else move(1); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); move(1); break;
      case 'ArrowUp': case 'k': e.preventDefault(); move(-1); break;
      case 'PageDown': e.preventDefault(); move(8); break;
      case 'PageUp': e.preventDefault(); move(-8); break;
      case 'Enter': case ' ': if (tag === 'BUTTON' || tag === 'A') return; e.preventDefault(); togglePlay(); break;
      case '/': e.preventDefault(); els.q.focus(); els.q.select(); break;
      case 'f': toggleFav(); break;
      case 'Escape': deselect(); break;
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) laneLoop(); });
  window.addEventListener('hashchange', () => {
    const s = songFromHash();
    if (s && s.id !== state.sel) { if (!visible.includes(s)) clearFilters(); select(s.id, { play: false, sound: false, scroll: 'center' }); }
  });
}

function songFromHash() {
  let wanted = '';
  try { wanted = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed hash */ }
  return wanted ? SONGS.find((s) => s.key === wanted) : null;
}

// ------------------------------------------------------------------ boot
async function boot() {
  const [data, baked] = await Promise.all([
    fetch('data/songs.json').then((r) => r.json()),
    fetch('data/previews.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  DATA = data; PACKS = data.packs; SONGS = data.songs;
  setBaked(baked);
  const titleCount = {};
  for (const s of SONGS) titleCount[s.t] = (titleCount[s.t] || 0) + 1;
  for (const s of SONGS) {
    const packs = (s.d || []).map((id) => PACKS[id]);
    s.key = titleCount[s.t] > 1 ? `${s.t}｜${s.s || ''}` : s.t;
    s.date = [...packs.map((p) => p.date), s.pd || ''].sort().pop() || '';
    s.hay = fold([s.t, s.k, s.e, s.s, s.se, s.x, ...(s.a || []), s.ae, ...packs.flatMap((p) => [p.name, p.en])].filter(Boolean).join('|'));
    // romaji: machine readings of the Japanese text, plus the English fields (often romaji themselves)
    s.rom = romaKey([s.r, s.e, s.ae, s.se, ...packs.flatMap((p) => [p.r, p.en])].filter(Boolean).join('|'));
  }
  applyI18n();
  buildList();
  buildControls();
  bind();
  apply({ keepScroll: true });
  const hit0 = songFromHash();
  if (hit0) select(hit0.id, { play: false, sound: false, scroll: 'center' });
  laneLoop();
  window.__dsb = { state, player, SONGS, PACKS, select, apply, visible: () => visible };
}

boot().catch((err) => {
  console.error(err);
  els.empty.hidden = false;
  els.empty.querySelector('p').textContent = 'Could not load the song list. Serve this folder over HTTP (e.g. python3 -m http.server).';
});
