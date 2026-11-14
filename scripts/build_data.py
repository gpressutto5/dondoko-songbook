#!/usr/bin/env python3
"""Builds data/songs.json for the Rhythm Festival song browser.

Sources
  - Official Bandai Namco song lists (base game, Taiko Music Pass, DLC) -> the catalogue itself
  - 太鼓の達人 譜面とかWiki (wikiwiki.jp/taiko-fumen) -> Rhythm Festival BPM + difficulty stars
  - taiko.wiki open song database -> artists, English titles, arcade BPM / stars as fallback
  - taiko.fandom.com + furukon.com -> extra English titles / artists

Usage:  python3 scripts/build_data.py [--refresh]
Downloads are cached in scripts/.cache (use --refresh to re-download).
"""
import collections, datetime, html, json, os, re, sys, time, unicodedata, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'scripts', '.cache')
OUT = os.path.join(ROOT, 'data', 'songs.json')
OFFICIAL = 'https://dondafulfestival-20th.taiko-ch.net/music/'
SOURCES = {
    'songlist.html': OFFICIAL + 'songlist.php',
    'songlist_other.html': OFFICIAL + 'songlist_other.php',
    'musicpass_list.html': OFFICIAL + 'musicpass_list.php',
    'dlc.html': OFFICIAL + 'dlc.php',
    'wiki_all.json': 'https://taiko.wiki/api/v1/song/all',
    'furukon.html': 'https://www.furukon.com/?game=3',
    'fandom.json': 'https://taiko.fandom.com/api.php?action=parse&page=Taiko_no_Tatsujin:_Rhythm_Festival&prop=wikitext&format=json',
}
# 太鼓の達人 譜面とかWiki: per-genre tables with Rhythm Festival BPM + star levels.
WW = 'https://wikiwiki.jp/taiko-fumen/'
WW_GENRES = ['ポップス', 'アニメ', 'ボーカロイド™曲', 'バラエティ', 'クラシック', 'ゲームミュージック', 'ナムコオリジナル']
for _i, _g in enumerate(WW_GENRES, 1):
    SOURCES['ww_%d.html' % _i] = WW + urllib.parse.quote('作品/NS2/' + _g)
    SOURCES['wwp_%d.html' % _i] = WW + urllib.parse.quote('作品/NS2/太鼓ミュージックパス/' + _g)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'


def fetch(name, refresh=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if refresh or not os.path.exists(path):
        slow = name.startswith('ww')  # the chart wiki rate-limits hard: ~1 page / 40 s
        for attempt in range(5):
            try:
                req = urllib.request.Request(SOURCES[name], headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    body = r.read()
                with open(path, 'wb') as f:
                    f.write(body)
                print('  fetched', name, len(body), file=sys.stderr)
                if slow:
                    time.sleep(40)
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4:
                    raise
                time.sleep(60)
    return open(path, encoding='utf-8').read()


def wikitext(s):
    s = re.sub(r'\[\[(?:[^\]|]*\|)?([^\]]*)\]\]', r'\1', s or '')
    s = re.sub(r'\{\{Tt\|([^|}]*)\|[^}]*\}\}', r'\1', s)
    s = s.replace("'''", '').replace("''", '')
    return clean(s)


def chart_wiki(refresh):
    """title key -> dict(bpm=[..], lv=[easy, normal, hard, oni(, ura)]) from the chart wiki tables."""
    out = {}
    for name in sorted(n for n in SOURCES if n.startswith('ww')):
        try:
            page = fetch(name, refresh)
        except Exception as e:  # optional enrichment: keep going without it
            print('  skip', name, e, file=sys.stderr)
            continue
        for row in re.findall(r'<tr.*?</tr>', page, re.S):
            if '★' not in row:
                continue
            tds = re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)
            if len(tds) not in (8, 9):  # [added (Music Pass pages only)], mark, title, bpm, 5 courses
                continue
            m = re.search(r'<strong>(.*?)</strong>', tds[-7], re.S)
            if not m:
                continue
            lv = []
            for c in tds[-5:]:
                x = re.search(r'★×(\d+)', c)
                lv.append(int(x.group(1)) if x else 0)
            nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', clean(tds[-6]))]
            nums = [int(x) if x == int(x) else x for x in nums]
            rec = dict(lv=lv if lv[4] else lv[:4])
            if nums:
                rec['bpm'] = [min(nums), max(nums)] if min(nums) != max(nums) else [nums[0]]
            if len(tds) == 9:
                d = re.match(r'(\d\d)/(\d{1,2})/(\d{1,2})', clean(tds[0]))
                if d:
                    rec['added'] = '20%s-%02d-%02d' % (d.group(1), int(d.group(2)), int(d.group(3)))
            key = norm(clean(m.group(1)))
            sub = re.search(r'<span style="font-size:11px">(.*?)</span>', tds[-7], re.S)
            for kk in (key, key + '|' + norm(clean(sub.group(1)) if sub else '')):
                if kk in out:
                    if rec.get('added'):
                        out[kk].setdefault('added', rec['added'])
                else:
                    out[kk] = dict(rec)
    return out


def fandom(refresh):
    """title key -> dict(en=, artist=) from the English Fandom wiki page for the game."""
    out = {}
    try:
        text = json.loads(fetch('fandom.json', refresh))['parse']['wikitext']['*']
    except Exception as e:
        print('  skip fandom', e, file=sys.stderr)
        return out
    # Music Pass list (templates)
    for m in re.finditer(r'\{\{Game music list/List\|(.*?)\}\}(?=\s*(?:\{\{Game|\n|\|\}|$))', text, re.S):
        f = {}
        for part in re.split(r'\|(?=(?:Genre|English name|Japanese name|Artist|Note|Ura)=)', m.group(1)):
            k, _, v = part.partition('=')
            f[k.strip()] = wikitext(v)
        en = f.get('English name', '')
        e = dict(en=en, artist=f.get('Artist', ''), note=f.get('Note', ''))
        for key in (f.get('Japanese name'), en):
            if key:
                out.setdefault(norm(key), e)
    # base game table
    base = text[text.find('===Base game'):text.find('===Taiko Music Pass')]
    for row in base.split('\n|-')[1:]:
        cell = row.strip().split('\n|')[0]
        mj = re.search(r'<span lang="ja">(.*?)</span>', cell, re.S)
        def split(x):
            a = re.search(r'<div[^>]*>(.*?)</div>', x, re.S)
            return wikitext(re.sub(r'<br\s*/?>\s*<div.*', '', x, flags=re.S).lstrip('|')), wikitext(a.group(1)) if a else ''
        en, artist = split(re.sub(r'<br>\s*<span lang="ja">.*', '', cell, flags=re.S))
        cols = row.strip().split('\n|')
        note = wikitext(cols[1]) if len(cols) > 2 and 'style=' not in cols[1] else ''
        e = dict(en=en, artist=artist, note=note)
        if mj:
            out.setdefault(norm(split(mj.group(1))[0]), e)
        if en:
            out.setdefault(norm(en), e)
    return out


def clean(s):
    s = re.sub(r'<rt>.*?</rt>', '', s, flags=re.S)
    s = re.sub(r'<br\s*/?>', ' ', s)
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


def reading(s):
    s = re.sub(r'<ruby>(.*?)<rt>(.*?)</rt></ruby>', r'\2', s, flags=re.S)
    return clean(s)


def norm(s):
    """Loose key used to match the same song across sources."""
    s = unicodedata.normalize('NFKC', s or '').lower()
    s = s.replace('〜', '~').replace('～', '~').replace('’', "'").replace('”', '"').replace('“', '"')
    s = re.sub(r'[\s　・･·.,!?\'"`~\-‐‑–—―ー−:;/\\()\[\]{}「」『』【】<>《》〈〉♪☆★♡♥❤︎️⤴↑＊*#＃&＆+＋=＝_|…‥。、，．]', '', s)
    return s


GENRES = ('pops', 'anime', 'vocaloid', 'variety', 'classic', 'game', 'namco')
# ordered replacements that turn the Japanese DLC pack names into English ones
PACK_EN = [
    ('TVアニメ『ONE PIECE』25周年記念コラボパック', 'ONE PIECE TV Anime 25th Anniversary Collab Pack'),
    ('「アニメちいかわ」コラボパック', 'Chiikawa Anime Collab Pack'),
    ('【推しの子】コラボパック', 'Oshi no Ko Collab Pack'),
    ('シン・ジャパン・ヒーローズ・ユニバース', 'Shin Japan Heroes Universe'),
    ('クレヨンしんちゃん主題歌', 'Crayon Shin-chan Theme Songs '),
    ('ドラゴンボール主題歌', 'Dragon Ball Theme Songs '),
    ('ワンピース主題歌', 'One Piece Theme Songs '),
    ('仮面ライダー主題歌', 'Kamen Rider Theme Songs '),
    ('東方Projectアレンジ', 'Touhou Project Arrange '),
    ('スタジオジブリ', 'Studio Ghibli '),
    ('鏡音リン・鏡音レン', 'Kagamine Rin & Len'),
    ('初音ミク', 'Hatsune Miku'), ('重音テト', 'Kasane Teto '),
    ('ボーカロイド™曲コレクション', 'VOCALOID™ Song Collection'),
    ('アニソンコレクション', 'Anime Song Collection'), ('ポップスコレクション', 'Pops Collection'),
    ('童謡・歌謡曲', 'Nursery Rhymes & Kayokyoku '),
    ('2000シリーズ', '2000 Series '), ('年代ポップス', 's Pops '), ('クラシック', 'Classical '),
    ('アニメ', 'Anime '), ('キッズ', 'Kids '), ('パック', ' Pack '), ('コラボ', ' Collab'),
]


def pack_en(name):
    for jp, en in PACK_EN:
        name = name.replace(jp, en)
    return re.sub(r'\s+', ' ', name).strip()

LI = re.compile(r'<li class="([^"]*)">\s*<dl>\s*<dt class="[^"]*">(.*?)</dt>(.*?)</dl>', re.S)


def items(chunk):
    out = []
    for m in LI.finditer(chunk):
        cls = m.group(1).split()
        sub = ''
        for c, t in re.findall(r'<dd(?: class="([^"]*)")?>(.*?)</dd>', m.group(3), re.S):
            if c != 'annotation' and clean(t):
                sub = clean(t)
        if not cls or cls[0] not in GENRES:
            continue  # banners etc.
        title = clean(m.group(2))
        kana = reading(m.group(2))
        out.append(dict(genre=cls[0] if cls else '', new='new' in cls, title=title,
                        kana=kana if kana != title else '', sub=sub))
    return out


def list_part(page):
    return page[page.find('class="listColInner'):]


def jp_date(s):
    m = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日', s)
    return '%04d-%02d-%02d' % tuple(map(int, m.groups())) if m else ''


# ---------------------------------------------------------------- English names and romaji
JP = re.compile(r'[぀-ヿ㐀-鿿]')
NAMES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'en_names.json')


def load_names():
    d = json.load(open(NAMES_FILE, encoding='utf-8'))
    nk = lambda x: unicodedata.normalize('NFKC', x)
    titles = {nk(k): v for k, v in d['titles'].items()}
    names = sorted(((nk(k), v) for k, v in d['names'].items()), key=lambda kv: -len(kv[0]))
    fixes = sorted(((nk(k), v) for k, v in d.get('romaji', {}).items()), key=lambda kv: -len(kv[0]))
    return titles, names, fixes


def en_text(text, names):
    """Translate a credit / subtitle with the hand-kept names; None if Japanese text is left over."""
    t = unicodedata.normalize('NFKC', text or '')
    if not JP.search(t):
        return None
    for jp, en in names:
        t = t.replace(jp, en)
    t = re.sub(r'(TV Anime|Anime|Movie|Drama|Game)?\s*[「『]([^」』]*)[」』]\s*より',
               lambda m: (' from the %s “%s” ' % (m.group(1).lower().replace('tv', 'TV'), m.group(2)) if m.group(1) else ' from “%s” ' % m.group(2)), t)
    t = re.sub(r'[「『]([^」』]*)[」』]', r' “\1” ', t)
    t = t.replace('・', ' & ').replace('、', ', ')
    t = re.sub(r'\s+', ' ', t).strip().replace('“', '"').replace('”', '"')
    if JP.search(t):
        return None
    return (t if t.startswith('feat') else t[0].upper() + t[1:]) if t else None


def romanizer(fixes=()):
    """Hepburn romaji for search ("shiruetto" finds シルエット). Needs pykakasi; None without it."""
    try:
        import pykakasi
    except ImportError:
        return None
    kks = pykakasi.kakasi()

    def rom(text):
        text = unicodedata.normalize('NFKC', text or '')
        if not JP.search(text):
            return ''
        for jp, reading in fixes:
            text = text.replace(jp, ' ' + reading + ' ')
        return re.sub(r'[^a-z0-9]+', '', ''.join(i['hepburn'] for i in kks.convert(text)).lower())
    return rom



def main():
    en_titles, en_names, rom_fixes = load_names()
    rom = romanizer(rom_fixes)
    old_rom = {}
    if not rom:
        print('pykakasi is not installed: keeping the romaji already in songs.json (pip install pykakasi)')
        if os.path.exists(OUT):
            old_rom = {(r['t'], r.get('s')): r.get('r') for r in json.load(open(OUT, encoding='utf-8'))['songs']}
    refresh = '--refresh' in sys.argv
    songs = collections.OrderedDict()

    def get(it, seen):
        # Same title + different subtitle inside one list = a different song (e.g. the two
        # "トルコ行進曲", or collab re-recordings); those get a "title|subtitle" key.
        k = norm(it['title'])
        k2 = k + '|' + norm(it['sub'])
        if k2 in songs:
            k = k2
        elif k in seen:
            k = k2
        seen.add(k)
        seen.add(k.split('|')[0])
        s = songs.get(k)
        if not s:
            s = songs[k] = dict(title=it['title'], kana=it['kana'], sub=it['sub'], genre=it['genre'],
                                base=[], music_pass=False, new=False, dlc=[])
        if not s['sub'] and it['sub']:
            s['sub'] = it['sub']
        if not s['kana'] and it['kana']:
            s['kana'] = it['kana']
        return s

    # 1. base game (Switch + other platforms)
    for f, plat in (('songlist.html', 'switch'), ('songlist_other.html', 'other')):
        seen = set()
        for it in items(list_part(fetch(f, refresh))):
            s = get(it, seen)
            if plat not in s['base']:
                s['base'].append(plat)

    # 2. Taiko Music Pass
    mp = fetch('musicpass_list.html', refresh)
    seen = set()
    for it in items(list_part(mp)):
        s = get(it, seen)
        s['music_pass'] = True
        s['new'] = s['new'] or it['new']
    m = re.search(r'<h4><span>(\d{4})年(\d{1,2})月の追加楽曲', mp)
    pass_update = '%s-%02d' % (m.group(1), int(m.group(2))) if m else ''

    # 3. DLC packs
    dlc = list_part(fetch('dlc.html', refresh))
    parts = re.split(r'(<h4 class="[^"]*dlcTit[^"]*">.*?</h4>)', dlc, flags=re.S)
    packs = []
    for i in range(1, len(parts), 2):
        spans = re.findall(r'<span(?: class="[^"]*")?>(.*?)</span>', parts[i], re.S)
        name = clean(spans[0])
        info = clean(spans[1]) if len(spans) > 1 else ''
        price = re.search(r'([\d,]+)円', info)
        plat = 'all'
        if 'Nintendo Switch' in name and ('のみ' in name or '版' in name):
            plat = 'switch'
        elif 'PlayStation' in name:
            plat = 'other'
        short = re.sub(r'\s*[（(]\s*(単曲販売|Nintendo Switch™版|PlayStation.*?版)\s*[）)]', '', name)
        short = re.sub(r'\s*Nintendo Switch™のみ', '', short).strip()
        single = '単曲販売' in name
        discontinued = 'シン・ジャパン・ヒーローズ・ユニバース' in name
        pack = dict(id=len(packs), name=short, en=pack_en(short), single=single, date=jp_date(info),
                    price=int(price.group(1).replace(',', '')) if price else None,
                    platform=plat, discontinued=discontinued, count=0)
        seen = set()
        for it in items(parts[i + 1]):
            s = get(it, seen)
            if pack['id'] not in s['dlc']:
                s['dlc'].append(pack['id'])
                pack['count'] += 1
        packs.append(pack)

    # 4. enrichment: taiko.wiki
    wiki = json.loads(fetch('wiki_all.json', refresh))
    widx = {}
    for w in wiki:
        widx.setdefault(norm(w['title']), w)
    # 5. enrichment: furukon (EN title / artist)
    fidx = {}
    for cell in re.findall(r'<tr><td><input[^>]*></td><td>(.*?)</td>', fetch('furukon.html', refresh), re.S):
        blocks = [b.strip().split('\n') for b in re.split(r'\n\s*\n', html.unescape(cell).strip())]
        en, jp = blocks[0], blocks[-1]
        e = dict(en=en[0].strip(), en_artist=en[1].strip() if len(en) > 1 else '',
                 jp_artist=jp[1].strip() if len(jp) > 1 else '')
        fidx.setdefault(norm(jp[0]), e)
        fidx.setdefault(norm(en[0]), e)

    ww = chart_wiki(refresh)
    fan = fandom(refresh)

    title_count = collections.Counter(norm(x['title']) for x in songs.values())
    stats = collections.Counter()
    out = []
    for n, (k, s) in enumerate(songs.items()):
        tk = norm(s['title'])
        exact = tk + '|' + norm(s['sub'])
        if title_count[tk] > 1:  # same-title variants: only trust an exact title+subtitle match
            w = f = fd = None
            c = ww.get(exact) or ww.get(tk)
        else:
            w, f, fd = widx.get(k), fidx.get(k), fan.get(k)
            c = ww.get(exact) or ww.get(k)
        rec = dict(id=n, t=s['title'], g=s['genre'])
        sub = s['sub']
        if 'Nintendo Switch™のみ' in sub:
            rec['sw'] = 1
            sub = sub.replace('Nintendo Switch™のみ', '').strip()
        if s['kana']:
            rec['k'] = s['kana']
        if sub:
            rec['s'] = sub
        if s['base']:
            rec['b'] = s['base']
        if s['music_pass']:
            rec['p'] = 1
        if s['new']:
            rec['n'] = 1
        if s['dlc']:
            rec['d'] = s['dlc']
        en, artists, en_artist = '', [], ''
        if w:
            stats['taiko.wiki'] += 1
            en = w.get('titleEn') or ''
            artists = [a for a in (w.get('artists') or []) if a]
            b = w.get('bpm') or {}
            if b.get('max'):
                rec['bpm'] = [b['min'], b['max']] if b.get('min') and b['min'] != b['max'] else [b['max']]
            cs = w.get('courses') or {}
            lv = [(cs.get(x) or {}).get('level') or 0 for x in ('easy', 'normal', 'hard', 'oni', 'ura')]
            if any(lv):
                rec['lv'] = lv if lv[4] else lv[:4]
            rec['w'] = w['songNo']
        if c:  # game-specific numbers win over the arcade ones
            stats['chart wiki'] += 1
            rec['lv'] = c['lv']
            if c.get('bpm'):
                rec['bpm'] = c['bpm']
            if c.get('added') and s['music_pass']:
                rec['pd'] = c['added']
        if fd:
            stats['fandom'] += 1
            en = en or fd['en']
            en_artist = fd['artist']
            if fd.get('note'):
                rec['x'] = fd['note'][0].upper() + fd['note'][1:]
        if f:
            stats['furukon'] += 1
            en = en or f['en']
            if not artists and f['jp_artist']:
                artists = [f['jp_artist']]
            en_artist = en_artist or f['en_artist']
        if en and norm(en) != k:
            rec['e'] = en
        if artists:
            rec['a'] = artists
        if en_artist and norm(en_artist) not in [norm(a) for a in artists]:
            rec['ae'] = en_artist
        nt = unicodedata.normalize('NFKC', rec['t'])
        if 'e' not in rec and nt in en_titles:
            rec['e'] = en_titles[nt]
        if artists and 'ae' not in rec and any(JP.search(a) for a in artists):
            tr = [en_text(a, en_names) if JP.search(a) else a for a in artists]
            if all(tr):
                rec['ae'] = ', '.join(tr)
        if rec.get('s'):
            se = en_text(rec['s'], en_names)
            if se:
                rec['se'] = se
        if rom:  # machine romaji, for search only: title, readings, credits, subtitle
            r = '|'.join(dict.fromkeys(x for x in map(rom, [rec['t'], rec.get('s'), *artists]) if x))
            if r:
                rec['r'] = r
        elif old_rom.get((rec['t'], rec.get('s'))):
            rec['r'] = old_rom[(rec['t'], rec.get('s'))]
        stats['with english artist'] += 'ae' in rec
        stats['with romaji'] += 'r' in rec
        stats['with levels'] += 'lv' in rec
        stats['with artist'] += bool(artists or en_artist)
        stats['with english title'] += 'e' in rec
        out.append(rec)

    # single-song "packs" are named after the song: reuse its English title
    by_title = {norm(r['t']): r for r in out}
    for p in packs:
        if p['single']:
            r = by_title.get(norm(p['name']))
            p['en'] = (r or {}).get('e') or p['name']
        if JP.search(p['en']):
            p['en'] = en_text(p['en'], en_names) or p['en']
        if p['en'] == p['name']:
            del p['en']
        elif rom and JP.search(p['name']):
            p['r'] = rom(p['name'])

    data = dict(
        generated=datetime.date.today().isoformat(),
        pass_update=pass_update,
        counts=dict(total=len(out), base=sum(1 for r in out if r.get('b')),
                    music_pass=sum(1 for r in out if r.get('p')), dlc=sum(1 for r in out if r.get('d'))),
        packs=packs, songs=out)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(',', ':'))
    print(data['counts'], dict(stats), 'packs', len(packs), 'bytes', os.path.getsize(OUT))
    if '--unmatched' in sys.argv:
        for r in out:
            if 'lv' not in r:
                print('  no levels:', r['g'], '|', r['t'], '|', r.get('s', ''))


if __name__ == '__main__':
    main()
