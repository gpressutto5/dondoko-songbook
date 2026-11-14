#!/usr/bin/env python3
"""Pre-resolves 30-second audio previews for every song via the public iTunes Search API
and writes data/previews.json, so the app can play instantly without a lookup.

Resumable: re-run to continue / pick up new songs. `--retry-missing` re-checks songs
that had no match; `--recheck` re-resolves matches that only the title vouched for. The API allows roughly 20 requests a minute, hence the slow pace.
The matching rules mirror js/preview.js (the app falls back to a live lookup there).
"""
import collections, json, os, re, sys, time, unicodedata, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SONGS = os.path.join(ROOT, 'data', 'songs.json')
OUT = os.path.join(ROOT, 'data', 'previews.json')
DELAY = 3.5

KATA = {c: c - 0x60 for c in range(0x30a1, 0x30f7)}
PUNCT = re.compile(r'[\s　・･.,!?\'"`’~〜\-‐–—ー:;/()\[\]「」『』【】<>♪☆★♡♥&＆+]')
FEAT = re.compile(r'\s*[(\[（]?\s*(?<![a-z])(?:feat\.|ft\.|feat\s|featuring\s)\s*[^)\]）]*[)\]）]?', re.I)
ARTIST_SEP = re.compile(r'\s*(?:[&＆,、/×+()（）\[\]]|\bfeat\.?|\bft\.|\bwith\b|\band\b|\bof\b|\bfrom\b|\bCV[:.]?)\s*', re.I)
VARIANT = re.compile(r'ver\.|version|remix|リミックス|live|ライブ|acoustic|アコースティック|tv ?size|tvサイズ|short|demo|remaster', re.I)
BAD = re.compile(r'カラオケ|karaoke|オルゴール|music ?box|instrumental|インスト|off ?vocal|ガイド|歌ってみた|made famous|tribute|originally performed|8 ?bit|ピアノ|piano ver|bgm|着信|メロディ', re.I)


def norm(s):
    return PUNCT.sub('', unicodedata.normalize('NFKC', s or '').lower().translate(KATA))


def strip_parens(s):
    return re.sub(r'\s*[(\[（［〈<~〜\-－].*$', '', s or '')


def prefixed(a, b):
    x, y = (a, b) if len(a) <= len(b) else (b, a)
    return len(x) >= 3 and y.startswith(x) and len(x) >= 0.6 * len(y)


def title_score(song, track_name):
    """4 = same title, 3.5 = same once "(…)" suffixes are dropped, 2.5 = close prefix, 0 = different song."""
    track_name = FEAT.sub('', track_name or '')  # "Title (feat. X)" is still "Title"
    tn, tn2 = norm(track_name), norm(strip_parens(track_name))
    best = 0
    for raw in (song['t'], song.get('e')):
        a, a2 = norm(raw), norm(strip_parens(raw))
        if not a:
            continue
        if tn == a:
            return 4
        if tn2 and (tn2 == a or tn2 == a2 or tn == a2):
            best = max(best, 3.5)
        elif prefixed(tn, a):
            best = max(best, 2.5)
    return best


TAIKO = re.compile(r'太鼓の達人|taiko', re.I)
# store genres a classical / traditional tune can plausibly be filed under
TRAD_GENRE = re.compile(r'クラシック|classical|チルドレン|children|童謡|オペラ|opera|歌謡曲|演歌|enka|ホリデー|holiday|ジャズ|jazz', re.I)

# Hand-checked corrections, keyed like previews.json: None = "the store has no recording of this one".
OVERRIDES = {
    'Priyo City': None,   # only unrelated songs share these titles
    'THE FIXER': None,
    'DESERT STORM': None,
}
# Store spellings of performers that the wikis credit differently (added to the song's artists).
ARTIST_HINTS = {
    'BLUE SAPPHIRE': ['HIROOMI TOSAKA'],
    'Baby Shark（ベイビー・シャーク）': ['ピンキッツ', 'Pinkfong'],
}


def parts(name):
    return [x for x in map(norm, ARTIST_SEP.split(name or '')) if len(x) >= 2]


def same(p, q):
    return p == q or (min(len(p), len(q)) >= 3 and (p in q or q in p))


def artist_hits(song, artist_name):
    """Does the store artist agree with the song's credits (artists or official subtitle)?"""
    an = norm(artist_name)
    if len(an) < 2:
        return 0, False
    credits = [c for c in list(song.get('a') or []) + [song.get('ae')] if c]
    whole = [a for a in map(norm, credits) if len(a) >= 2]
    theirs = parts(artist_name)
    # "A feat. B" and "A & B" are the same credit: compare the individual names too
    mine = {p for c in credits for p in parts(c)}
    hits = sum(1 for p in mine if any(same(p, q) for q in theirs)) \
        or sum(1 for a in whole if a in an or an in a)
    if not hits and any(q in norm(song.get('s')) for q in theirs):
        hits = 1  # the official subtitle often credits the performer
    # a romanised credit can't be checked against a Japanese store name (or the reverse)
    return hits, any(a.isascii() == an.isascii() for a in whole)


def score(song, r):
    name, coll, artist = r.get('trackName') or '', r.get('collectionName') or '', r.get('artistName') or ''
    s = title_score(song, name)
    if not s or not r.get('previewUrl'):
        return 0
    hits, comparable = artist_hits(song, artist)
    if hits:
        s += 2.5 + 0.5 * min(hits, 3)
    elif TAIKO.search(coll + ' ' + artist):
        s += 2.5
    elif song.get('g') == 'namco':
        return 0  # Namco originals often have everyday titles shared with unrelated songs
    elif song.get('g') == 'classic' and not TRAD_GENRE.search(r.get('primaryGenreName') or ''):
        return 0  # same for classical pieces, unless the store files the track under a fitting genre
    elif comparable:
        s -= 1
    if BAD.search(' '.join([name, coll, artist])):
        s -= 3
    if VARIANT.search(name) and not VARIANT.search(song['t'] + ' ' + (song.get('e') or '')):
        s -= 1
    if 'たいこのたつしん' in norm(coll):
        s += 0.5
    if song.get('g') == 'classic' and re.search(r'クラシック|classical', r.get('primaryGenreName') or '', re.I):
        s += 0.5
    if unicodedata.normalize('NFKC', name).strip() == unicodedata.normalize('NFKC', song['t']).strip():
        s += 0.25  # "TWILIGHT!!!" should beat "Twilight" when both are on offer
    return s


def search(term, country):
    q = urllib.parse.urlencode(dict(term=term, country=country, media='music', entity='song', limit=25))
    for attempt in range(4):
        try:
            with urllib.request.urlopen('https://itunes.apple.com/search?' + q, timeout=30) as r:
                return json.load(r).get('results') or []
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and attempt < 3:
                print('  rate limited (%d), waiting…' % e.code, flush=True)
                time.sleep(45 * (attempt + 1))
                continue
            raise
        finally:
            time.sleep(DELAY)
    return []


def lookup(song):
    artists = song.get('a') or []
    queries = [(song['t'], 'JP')]
    for a in dict.fromkeys([artists[-1], artists[0]] if artists else []):
        queries.append((song['t'] + ' ' + a, 'JP'))
    if song.get('ae'):
        queries.append((song['t'] + ' ' + song['ae'], 'JP'))  # the JP store indexes romanised names too
    if song.get('e'):
        queries.append(((song['e'] + ' ' + (song.get('ae') or '')).strip(), 'US'))
    elif song['t'].isascii():
        queries.append(((song['t'] + ' ' + (song.get('ae') or '')).strip(), 'US'))
    best, best_score = None, 0
    for term, country in queries:
        for r in search(term, country):
            sc = score(song, r)
            if sc > best_score:
                best, best_score = r, sc
        if best_score >= 6:
            break
    if best_score < 3.5:
        return None
    return dict(u=best['previewUrl'], n=best.get('trackName', ''), a=best.get('artistName', ''),
                l=re.sub(r'[?&]uo=\d+', '', best.get('trackViewUrl') or ''), i=best.get('artworkUrl100') or '')


def main():
    songs = json.load(open(SONGS, encoding='utf-8'))['songs']
    dup = collections.Counter(s['t'] for s in songs)
    out = json.load(open(OUT, encoding='utf-8')) if os.path.exists(OUT) else {}
    retry = '--retry-missing' in sys.argv
    recheck = '--recheck' in sys.argv
    todo = []
    for s in songs:
        key = s['t'] if dup[s['t']] == 1 else s['t'] + '｜' + s.get('s', '')
        if key in ARTIST_HINTS:
            s['a'] = list(s.get('a') or []) + ARTIST_HINTS[key]
        if key in OVERRIDES:
            out[key] = OVERRIDES[key]
            continue
        pv = out.get(key)
        if pv and not title_score(s, pv['n']):
            del out[key]  # matched under older, looser rules: resolve again
        elif pv and recheck and not artist_hits(s, pv['a'])[0] and not TAIKO.search(pv['a']):
            del out[key]  # nothing but the title vouched for it
        if key not in out or (retry and out[key] is None):
            todo.append((key, s))
    todo.sort(key=lambda ks: ks[1].get('g') == 'namco')  # licensed music first: far likelier to be on the store
    print('%d songs, %d to resolve' % (len(songs), len(todo)), flush=True)
    for n, (key, s) in enumerate(todo, 1):
        try:
            out[key] = lookup(s)
        except Exception as e:  # network trouble: leave it for the next run
            print('  !!', key, e, flush=True)
            continue
        if n % 10 == 0 or n == len(todo):
            with open(OUT + '.tmp', 'w', encoding='utf-8') as f:
                json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
            os.replace(OUT + '.tmp', OUT)
            found = sum(1 for v in out.values() if v)
            print('%d/%d  (%d with preview, %d without)' % (n, len(todo), found, len(out) - found), flush=True)


if __name__ == '__main__':
    main()
