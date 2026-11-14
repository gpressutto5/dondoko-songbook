# ドンドコ Songbook

An unofficial list of **every song in _Taiko no Tatsujin: Rhythm Festival_** — base game,
Taiko Music Pass and DLC — in a layout inspired by the game's song select, with search,
filters and audio previews.

## Running

It is a static site with no build step and no runtime dependencies. Serve the folder over HTTP:

```bash
python3 -m http.server 5173
```

then open <http://localhost:5173>. (Opening `index.html` straight from disk does not work,
because the browser blocks the `fetch` of the JSON data.)

## Features

- **Search** in English, Japanese or romaji: title, artist, series/anime and pack name.
  `silhouette`, `shiruetto` and `シルエット` all find the same song, and romaji spelling
  variants are tolerated (`shonen` / `shounen`, `wa` / `ha` for は).
- **Filters** by genre, source (base game / Music Pass / DLC), platform, DLC pack,
  Oni level (★1–10), songs with Ura, new songs and favorites.
- **Sorting** by official order, title, difficulty, BPM or date added.
- **30-second audio previews** (Apple Music / iTunes) that play on select, like in the game.
- Star level for each difficulty, BPM, where the song is available, and pack price and date.
- Keyboard: `↑` `↓` browse · `Enter` play/pause · `/` search · `F` favorite.
- Titles, artists and pack names in English (default) or Japanese. Responsive layout.

## Updating the catalogue

```bash
.venv/bin/python scripts/build_data.py --refresh   # download the lists and regenerate data/songs.json
python3 scripts/bake_previews.py                   # resolve previews for new songs into data/previews.json
python3 scripts/bake_previews.py --retry-missing --recheck   # retry songs without a preview and re-validate uncertain matches
```

`build_data.py` takes a few minutes with `--refresh` (the chart wiki rate-limits requests);
without the flag it rebuilds from the cached downloads in `scripts/.cache/`.
`bake_previews.py` is slow on purpose (Apple's API rate limit) and can be interrupted and
resumed; songs that have no baked entry yet are looked up live by the app.

### English names and romaji

English names the wikis don't cover are kept by hand in `scripts/en_names.json`:

- `titles` — Japanese song title → English (or romanised) title.
- `names` — artists, composers, series and stock phrases, applied as text replacement to
  artist credits and subtitles.
- `romaji` — corrections for readings the automatic romaniser gets wrong (search only).

The romaji used by search is generated with [`pykakasi`](https://pypi.org/project/pykakasi/),
the only build-time dependency:

```bash
python3 -m venv .venv && .venv/bin/pip install pykakasi
```

Without it, `build_data.py` still runs and keeps the romaji already stored in `data/songs.json`.

## Data sources

| Data | Source |
| --- | --- |
| Catalogue (base game, Music Pass, DLC) | [Official Bandai Namco site](https://dondafulfestival-20th.taiko-ch.net/music/songlist.php) |
| Difficulty and BPM | [太鼓の達人 譜面とかWiki](https://wikiwiki.jp/taiko-fumen/) |
| Artists and English titles | [taiko.wiki](https://taiko.wiki), [Taiko Wiki (Fandom)](https://taiko.fandom.com), [Furukon](https://www.furukon.com/?game=3), plus `scripts/en_names.json` |
| Audio previews | [iTunes Search API](https://performance-partners.apple.com/search-api) |

Previews are whatever recording Apple Music has, which may differ from the in-game version;
songs with no match link to a YouTube search instead.

---

Unofficial, non-commercial fan project. Taiko no Tatsujin™ is a trademark of Bandai Namco
Entertainment Inc.; this project is not affiliated with or endorsed by them.
