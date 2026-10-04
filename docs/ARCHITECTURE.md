# Architecture

## The idea
A button that works from any device (phone included) and runs a heavy job on free cloud compute: the person searches or
pastes a link, and the video / audio ends up in their Google Drive. Nothing runs, or costs, while idle.

```
person (phone / PC / any browser)
   |  login (password), search or paste a link, pick format / quality / item count
   v
Cloudflare Worker "yt-drive"        always on, free. Holds the secrets. Searches YouTube (Data API), Kan (daily
   |                                index) and Reshet 13 (its Kaltura OTT catalogue), builds previews, dispatches the workflow, reports live status.
   |  POST /repos/<owner>/yt-drive/actions/workflows/yt-drive.yml/dispatches   (with a random job_id)
   v
GitHub Actions  yt-drive.yml        free (public repo), Ubuntu runner, up to 240 min, ~14 GB disk
   |  YouTube: yt-dlp through Cloudflare WARP (GitHub IPs are bot-flagged)      ---> YouTube
   |  Kan:     page HTML direct; HLS segments through Worker "il-relay" (Tel Aviv) ---> Kan CDN (geo-gated to Israel)
   |  13:      Kaltura HLS by entry id, direct (il-relay as a fallback)                ---> Kaltura (partner 2748741)
   |  rclone: each finished item -> the user's Google Drive
   |  prerelease "job-<id>" = release notes (what was saved, warnings) - no media in it when Drive is on
   v
Cloudflare Worker  GET /api/jobs/:id   the page polls it: step progress, then "saved to Drive" or a download button
```

## Components
| Component | Where | Notes |
|---|---|---|
| Site Worker `yt-drive` | `worker\src\index.js`, `worker\wrangler.toml` | password gate (HMAC cookie `ytd`, 30 days, no server state), all API routes below, serves `worker\public\` (assets with `run_worker_first = true`) |
| Page (PWA) | `worker\public\index.html`, `sw.js`, `manifest.webmanifest`, `icon.svg` | Hebrew RTL, always dark ("TV screen" look, Heebo), installable, Android share target; one field for a search or a pasted link; source words: videos / playlists / Kan / 13; quality + item-count selectors; the Kan / 13 library as one horizontal poster rail per genre (a wrapping grid once filtered), one episode-list view; the downloads sit in a panel that is closed by default, fetched from GitHub only when opened and polled only while open (phone: a bar at the bottom that opens into a sheet; 900px and wider: the page uses the whole window width, a header button opens a column docked to the side and the page narrows to make room - nothing floats over the posters); the list is split into "on the way" / "finished", each download is a status mark + title + one line of facts, a running one adds a progress bar with the stage (queued / downloading n% / saving to Drive), and the technical summary + link to the GitHub run sit behind a per-item "details" toggle |
| Relay Worker `il-relay` | `relay\src\index.js`, `relay\wrangler.toml` | `[placement] region = "azure:israelcentral"` makes Cloudflare run it in Tel Aviv with an Israel-geolocated egress IP. `GET /r/<name>?k=<RELAY_KEY>&u=<url>` streams the URL; HLS playlists come back with every child URI rewritten through the relay. Key + host allowlist (kan.org.il, cdn-redge.media, kaltura.com) |
| Download workflow | `.github\workflows\yt-drive.yml` | see "Workflow" |
| Catalogue indexes | `scripts\build_kan_index.py` -> `data\kan-index.json`, `scripts\build_c13_index.py` -> `data\c13-index.json`, both refreshed by `.github\workflows\kan-index.yml` (03:23 UTC daily + manual; each step may fail alone) | Kan: 362 series scraped from the VOD lobby (section `s`). 13: 282 series with full episodes from the Kaltura OTT catalogue (genres `g`, date `d`, episode count `n`; the raw list is ~850 KB, too heavy for the Worker). The Worker reads both from raw.githubusercontent.com |

## Site API (all except login need the cookie)
| Route | Purpose |
|---|---|
| `POST /api/login` {password} / `GET /api/me` / `POST /api/logout` | session; `/api/me` also says whether YouTube search is configured |
| `GET /api/search?q=&type=video\|playlist` | YouTube Data API v3 (`search.list` + `videos.list` / `playlists.list`); 100+ units per search of the 10,000/day quota |
| `GET /api/info?url=` | preview of a pasted link: YouTube oEmbed (+ Data API for playlist title / item count), Kan Open Graph tags; tells episode / season / series apart |
| `GET /api/kan/search?q=` | Hebrew-normalised match (no niqqud / punctuation, all words must match) over `data/kan-index.json`; up to 30 series |
| `GET /api/c13/search?q=` | the same Hebrew-normalised match over `data/c13-index.json`; up to 30 series |
| `GET /api/library?source=kan\|c13` | the whole index of one channel {title, url, thumb, groups, count} for the library view; the page filters (as you type), groups (13: genre, Kan: section) and sorts (as on the site / A-Z) itself |
| `GET /api/episodes?url=` (alias `/api/kan/episodes`) | Kan: a series (-> first season + season list) or season page parsed into episodes. 13: seasons (lowest..highest SeasonNumber) and one season's episodes (default the newest season; by episode number, or the latest 100 when a season has more). Both return {title, seasons, season, episodes:[{url, title, duration, thumb}], source} |
| `POST /api/jobs` {input, options:{format, quality, playlist, max_items}} | validates the link (YouTube, Kan or 13; 13 links are rewritten to the canonical shape below), dispatches the workflow, returns the job id |
| `GET /api/jobs`, `GET /api/jobs/:id` | recent runs (matched by run title `yt [<id>]: <input>`); one job: status, current step, while the Download step runs `progress` (see below), and when done the `job-<id>` release notes + files |
| `GET /api/files/:assetId` | 302 to a short-lived download URL of a release asset (only used when Drive is off) |
| `POST /share` | PWA share-target fallback |

## Workflow `yt-drive.yml`
Inputs: `input` (URL), `format` video|audio, `quality` best|1080|720|480 (default 1080), `playlist` no|yes, `max_items`
1-100 (default 50), `job_id` (from the site; empty for manual runs). Run title: `yt [<job_id>]: <input>`.

1. **Install tools** - ffmpeg, deno (yt-dlp's JS runtime), yt-dlp + `bgutil-ytdlp-pot-provider` + curl-cffi from pip; a
   `brainicism/bgutil-ytdlp-pot-provider` service container supplies PO tokens.
2. **Cloudflare WARP** (proxy mode, socks5 127.0.0.1:40000) - the free egress that passes YouTube's bot check.
3. **Download**
   - YouTube: routes in order (secret `YT_PROXY` if set, else WARP, then direct) x player clients (default, web_embedded,
     tv+mweb, web_safari+android_vr). Single video: done when a real media file exists. Playlist / list link: done when
     yt-dlp exits 0, otherwise the next client retries the missing items (`--download-archive`).
   - Kan episode: resolve the m3u8 from the episode page, wrap it in the relay URL, hand it to yt-dlp (audio = the audio
     rendition only, `-f ba/b`). `kan_list.py` turns a series / season / episode link into "url, season, position in
     the season" lines (limit `max_items`; an episode link reads its season page for the series name and position),
     each downloaded in turn. Other Kan pages: one flat download as before.
   - **Already in Drive?** Kan / 13 file names are known before the download: `in_drive.sh` looks each one up in an
     `rclone lsf` of the series folder + the top of the Drive folder and skips it. A file found in an older layout
     (`<series>/NN - name` before season folders, `name` at the top for a single episode) is moved to its new place with
     `rclone moveto` (server side) instead. YouTube playlists: a `--flat-playlist -O "%(id)s %(filename)s"` pass (same
     `-o` template and `--trim-filenames`, which counts `out/` and the folder too) predicts every file name; ids of the
     ones Drive has go into `dl_archive.txt`, which yt-dlp skips. Single YouTube videos are not checked (the name needs
     a full extraction). rclone's `drive.file` scope sees only files and folders rclone created - anything put into
     Drive another way is invisible here and gets downloaded again.
   - Reshet 13: `c13_list.py` turns the link into Kaltura entry ids via the OTT catalogue (episode, season, or a whole
     series season by season; same order as the site's list). Each entry is fetched as HLS from
     `cdnapisec.kaltura.com/.../playManifest/entryId/<id>/format/applehttp/protocol/https/a.m3u8` (max 720p; the mp4
     renditions answer 404 everywhere) - straight from the runner, and through the relay only if that fails. Canonical
     links: `https://13tv.co.il/allshows/series/<sid>/[season/<n>/[<assetId>/]]`, or `https://13tv.co.il/allshows/<assetId>/`.
   - Only media extensions count as results; thumbnails, `.part` and subtitle leftovers are pruned.
   - With Drive configured, multi-item runs upload every finished item at once (`upload_one.sh`, `rclone moveto`) so the
     runner disk never holds a whole playlist / season and a timeout keeps what already finished.
4. **Deliver** - Drive (rclone remote `gdrive`) or, without Drive, one release asset (several files -> one zip).
5. **Publish result** - prerelease `job-<id>`: notes with source, format, `delivered:`, optional `reason:` / `warning:`
   (Kan / 13 season runs: `N of M items could not be downloaded` + a `not downloaded:` list, which the page shows as
   "N מתוך M פריטים לא ירדו"), `skipped: N already in Drive` + the list (`... (moved from ...)` for an old-layout file;
   the page: "N פריטים כבר היו בדרייב", or "כבר בדרייב" when nothing new was needed) and the `files:` list. (The release already exists since the Download step - see live progress - so its notes are
   replaced and the files uploaded; it is created here only if that early creation failed.)
6. **Cleanup** - `job-*` releases older than 14 days are deleted.

### Live download progress
The runner has no channel to the Worker except GitHub itself, so the `job-<id>` prerelease doubles as a mailbox:
- The Download step creates it at once (notes `progress: start`). yt-dlp runs with `--newline --progress-delta 2` and
  `--progress-template` (arrays `PROG` in the workflow) and prints one `PROGRESS dl|...` / `PROGRESS pp|...` line every
  2 s; the `show()` filter keeps the latest in `progress.txt` and sends everything else to the console and `dl.log` as
  before. A background loop patches the release notes every 5 s when the line changed (~1 API call / 5 s, GITHUB_TOKEN).
- `GET /api/jobs/:id` reads those notes while the current step is `Download` and returns `progress`:
  `{kind:"download", percent, downloaded, total, speed, eta, item, items, stream:"video"|"audio", fragment, fragments}`
  (nulls for what yt-dlp does not know; a merged video download runs twice, video then audio),
  `{kind:"post", postprocessor:"ExtractAudio"|"FFmpegMerger"|"Metadata"|"EmbedThumbnail"|"MoveFiles"...}` or `{kind:"start"}`.
- The page shows a bar + "45% · 12.3MB מתוך 27MB · 2.1MB/s · עוד 00:07 · פריט 2 מתוך 3" under the job while it downloads.
- If the early release creation fails the run goes on without live progress; the final notes are written the old way.

## Where files land in Drive (folder vars in parentheses)
```
YouTube/                                   (DRIVE_DIR, default "YouTube")
  <title>.mp4 | .mp3                       single video
  <playlist title>/NN - <title>.mp4|mp3    playlist items, zero-padded NN
Kan/                                       (KAN_DRIVE_DIR, default "Kan")
  <series>/עונה N/NN - <series> - <episode>.ext   an episode, alone or in a season / series run (name = the page's
                                           JSON-LD "series | episode - subtitle"; NN = position on the season page)
  <series> - <episode>.mp4|mp3             a Kan page outside /p-<id>/ (no season known)
13/                                        (C13_DRIVE_DIR, default "13")
  <series>/עונה N/NN - <asset name>.ext    an episode, alone or in a season / series run, e.g.
                                           "המעברה/עונה 2/07 - המעברה, עונה 2, פרק 7 - שן תחת שן.mp4"
```
One episode = one place, however it was asked for: a season run, a series run and a single-episode link all write the
same path, which is what lets a repeat run find it. 13's NN is the catalogue's EpisodeNumber (falls back to the
position in the season), so it is not always the number in the title: season 1 of "המעברה" opens with a
behind-the-scenes item, episode 1 is `02`. A season without a number: `<series>/NN - ...`; no NN known: no prefix.
Before 2026-10-05 seasons shared `<series>/NN - ...` with a running count, and single episodes landed at the top of
the folder - a run that meets such a file moves it to its new place (see "Already in Drive?").
Hebrew names are kept (`--windows-filenames`; yt-dlp turns `|` and `:` into the full-width `｜` `：`).

## Secrets and variables (names only - values are never in this repo)
| Where | Name | What |
|---|---|---|
| Worker `yt-drive` (secrets) | `APP_PASSWORD` | the site login password |
| | `GH_TOKEN` | fine-grained PAT, this repo only, Actions RW + Contents RW (expires: watch for the site's "GitHub token invalid or expired" message) |
| | `YT_API_KEY` | YouTube Data API v3 key (separate from any Gemini key) |
| Worker `yt-drive` (vars in `worker\wrangler.toml`) | `GH_REPO`, `GH_REF`, `WORKFLOW` | `as0527121640-debug/yt-drive`, `main`, `yt-drive.yml` |
| Worker `il-relay` (secret) | `RELAY_KEY` | shared key; same value as the repo secret |
| GitHub repo (secrets) | `RCLONE_CONF_BASE64` | base64 of an rclone.conf with remote `gdrive` (scope `drive.file`) |
| | `RELAY_KEY` | the relay key |
| | `YT_COOKIES` *(optional)* | cookies.txt of a secondary Google account - fallback for the bot check |
| | `YT_PROXY` *(optional)* | proxy URL (e.g. an Israeli residential one) - tried first when set |
| GitHub repo (variables) | `RELAY_URL` | `https://il-relay.moovitdos.workers.dev` |
| | `DRIVE_DIR`, `KAN_DRIVE_DIR`, `C13_DRIVE_DIR` *(optional)* | Drive folders (defaults `YouTube`, `Kan`, `13`) |
| This PC | `.local\relay.key` | copy of the relay key for manual tests (git-ignored) |

## Limits of the free tiers (design around them)
| Limit | Value | Consequence |
|---|---|---|
| Cloudflare Workers requests | 100,000 / day | the relay is hit once per 2-second HLS segment: ~3,000 per Kan video episode (~30 episodes/day), ~1,500 for audio |
| Worker CPU | 10 ms per request | never parse big HTML in the Worker (the 2 MB Kan lobby is parsed by a workflow; the Worker only filters the 90 KB index and parses ~120 KB episode pages) |
| YouTube Data API | 10,000 units / day | a search = 100 units, a link preview = 0 (oEmbed) or 1 (playlist details) |
| GitHub Actions | unlimited minutes (public repo), 240 min per job here, ~14 GB disk | per-item upload keeps big playlists off the disk |
| Release assets | 2 GB each | only matters when Drive is off |
| Site upload limit | none used | the site only takes links, not files |
