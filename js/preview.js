// Audio previews: 30-second clips from the public iTunes Search API (CORS-enabled, no key).
// Order of lookup: data/previews.json (baked at build time) -> localStorage cache -> live search.

const API = 'https://itunes.apple.com/search';
const CACHE_PREFIX = 'dsb:pv4:';
const MISS_TTL = 7 * 24 * 3600 * 1000;
let BAKED = {};
export const setBaked = (b) => { BAKED = b || {}; };

// results cached under older matching rules are no longer trusted
try {
  for (const k of Object.keys(localStorage)) if (/^dsb:pv[1-3]:/.test(k)) localStorage.removeItem(k);
} catch { /* ignore */ }

const norm = (s) => (s || '')
  .normalize('NFKC').toLowerCase()
  .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[\s\u3000・･.,!?'"`’~〜\-‐–—ー:;/()[\]「」『』【】<>♪☆★♡♥&＆+]/g, '');
const stripParens = (s) => (s || '').replace(/\s*[(\[（［〈<~〜\-－].*$/, '');
const FEAT = /\s*[([（]?\s*(?<![a-z])(?:feat\.|ft\.|feat\s|featuring\s)\s*[^)\]）]*[)\]）]?/i;
const ARTIST_SEP = /\s*(?:[&＆,、\/×+()（）[\]]|\bfeat\.?|\bft\.|\bwith\b|\band\b|\bof\b|\bfrom\b|\bCV[:.]?)\s*/i;
const VARIANT = /ver\.|version|remix|リミックス|live|ライブ|acoustic|アコースティック|tv ?size|tvサイズ|short|demo|remaster/i;
const BAD = /カラオケ|karaoke|オルゴール|music ?box|instrumental|インスト|off ?vocal|ガイド|歌ってみた|made famous|tribute|originally performed|8 ?bit|ピアノ|piano ver|bgm|着信|メロディ/i;

const ASCII = /^[\x00-\x7f]*$/;

// one name is the start of the other and covers most of it ("Title" vs "Title -Movie Edit-")
const prefixed = (a, b) => { const [x, y] = a.length <= b.length ? [a, b] : [b, a]; return x.length >= 3 && y.startsWith(x) && x.length >= 0.6 * y.length; };

/** 4 = same title, 3.5 = same once "(…)" suffixes are dropped, 2.5 = close prefix, 0 = different song. */
export function titleScore(song, rawName) {
  const trackName = (rawName || '').replace(FEAT, '');  // "Title (feat. X)" is still "Title"
  const tn = norm(trackName), tn2 = norm(stripParens(trackName));
  let best = 0;
  for (const raw of [song.t, song.e]) {
    const a = norm(raw), a2 = norm(stripParens(raw));
    if (!a) continue;
    if (tn === a) return 4;
    if (tn2 && (tn2 === a || tn2 === a2 || tn === a2)) best = Math.max(best, 3.5);
    else if (prefixed(tn, a)) best = Math.max(best, 2.5);
  }
  return best;
}

const TAIKO = /太鼓の達人|taiko/i;
// store genres a classical / traditional tune can plausibly be filed under
const TRAD_GENRE = /クラシック|classical|チルドレン|children|童謡|オペラ|opera|歌謡曲|演歌|enka|ホリデー|holiday|ジャズ|jazz/i;

const parts = (name) => (name || '').split(ARTIST_SEP).map(norm).filter((x) => x.length >= 2);
const same = (p, q) => p === q || (Math.min(p.length, q.length) >= 3 && (p.includes(q) || q.includes(p)));

/** Does the store artist agree with the song's credits (artists or official subtitle)? */
export function artistHits(song, artistName) {
  const an = norm(artistName);
  if (an.length < 2) return { hits: 0, comparable: false };
  const credits = [...(song.a || []), song.ae].filter(Boolean);
  const whole = credits.map(norm).filter((a) => a.length >= 2);
  const theirs = parts(artistName);
  // "A feat. B" and "A & B" are the same credit: compare the individual names too
  const mine = new Set(credits.flatMap(parts));
  let hits = [...mine].filter((p) => theirs.some((q) => same(p, q))).length
    || whole.filter((a) => an.includes(a) || a.includes(an)).length;
  if (!hits) {  // the official subtitle often credits the performer
    const sub = norm(song.s);
    if (theirs.some((q) => sub.includes(q))) hits = 1;
  }
  // a romanised credit can't be checked against a Japanese store name (or the reverse)
  const comparable = whole.some((a) => ASCII.test(a) === ASCII.test(an));
  return { hits, comparable };
}

/** Score an iTunes result against a song; <= 0 means "not this song". */
export function score(song, r) {
  let s = titleScore(song, r.trackName);
  if (!s || !r.previewUrl) return 0;
  const { hits, comparable } = artistHits(song, r.artistName);
  if (hits) s += 2.5 + 0.5 * Math.min(hits, 3);
  else if (TAIKO.test(`${r.collectionName} ${r.artistName}`)) s += 2.5;
  // Namco originals often have everyday titles shared with unrelated songs: demand confirmation
  else if (song.g === 'namco') return 0;
  // same for classical pieces, unless the store files the track under a fitting genre
  else if (song.g === 'classic' && !TRAD_GENRE.test(r.primaryGenreName || '')) return 0;
  else if (comparable) s -= 1;
  if (BAD.test(`${r.trackName} ${r.collectionName} ${r.artistName}`)) s -= 3;
  if (VARIANT.test(r.trackName) && !VARIANT.test(`${song.t} ${song.e || ''}`)) s -= 1;
  if (norm(r.collectionName).includes('たいこのたつしん')) s += 0.5;
  if (song.g === 'classic' && /クラシック|classical/i.test(r.primaryGenreName || '')) s += 0.5;
  // "TWILIGHT!!!" should beat "Twilight" when both are on offer
  if ((r.trackName || '').normalize('NFKC').trim() === song.t.normalize('NFKC').trim()) s += 0.25;
  return s;
}

const pack = (r) => ({ u: r.previewUrl, n: r.trackName, a: r.artistName, l: (r.trackViewUrl || '').replace(/[?&]uo=\d+/, ''), i: r.artworkUrl100 || '' });

async function search(term, country) {
  const url = `${API}?${new URLSearchParams({ term, country, media: 'music', entity: 'song', limit: '25' })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('itunes ' + res.status);
  return (await res.json()).results || [];
}

/** Live lookup. Returns a preview object, or null when nothing convincing was found. */
export async function lookup(song) {
  // title alone usually finds it; artist credits mix composers and performers, so try both ends
  const queries = [[song.t, 'JP']];
  const a = song.a || [];
  for (const artist of new Set(a.length ? [a[a.length - 1], a[0]] : [])) queries.push([`${song.t} ${artist}`, 'JP']);
  if (song.ae) queries.push([`${song.t} ${song.ae}`, 'JP']);  // the JP store indexes romanised names too
  if (song.e) queries.push([`${song.e} ${song.ae || ''}`.trim(), 'US']);
  else if (/^[\x20-\x7e]+$/.test(song.t)) queries.push([`${song.t} ${song.ae || ''}`.trim(), 'US']);
  let best = null, bestScore = 0, failures = 0;
  for (const [term, country] of queries) {
    let results;
    try { results = await search(term, country); } catch { failures++; continue; }
    for (const r of results) {
      const sc = score(song, r);
      if (sc > bestScore) { best = r; bestScore = sc; }
    }
    if (bestScore >= 6) break;
  }
  if (!best && failures === queries.length) throw new Error('preview lookup failed');
  return bestScore >= 3.5 ? pack(best) : null;
}

export function forgetPreview(song) {
  try { localStorage.removeItem(CACHE_PREFIX + song.key); } catch { /* ignore */ }
}

export async function findPreview(song, { force = false } = {}) {
  if (!force) {
    if (song.key in BAKED) return BAKED[song.key];
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_PREFIX + song.key) || 'null');
      if (c && (c.pv || Date.now() - c.at < MISS_TTL)) return c.pv;
    } catch { /* ignore */ }
  }
  const pv = await lookup(song);
  try { localStorage.setItem(CACHE_PREFIX + song.key, JSON.stringify({ pv, at: Date.now() })); } catch { /* ignore */ }
  return pv;
}
