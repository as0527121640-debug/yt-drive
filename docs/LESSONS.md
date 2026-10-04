# Lessons - what broke, why, and what fixed it

Everything here was measured on real runs (2026-09-30) unless marked otherwise. The generalised version, for building
the next site of this kind, is the skill `cloud-job-site` (`references\youtube-to-drive.md`).

## YouTube
- **GitHub runner IPs are bot-flagged.** Every video, even "Me at the zoo", failed with "Sign in to confirm you're not a
  bot". Not enough on their own: deno (yt-dlp's JS runtime), a PO-token sidecar, alternate player clients. What works:
  **Cloudflare WARP in proxy mode** (`cloudflare-warp` package, `warp-cli mode proxy`, socks5 127.0.0.1:40000) - MP3,
  video and playlists all passed. Route order: `YT_PROXY` if set -> WARP -> direct. Tor (even with `ExitNodes {il}`) is
  blocked by YouTube ("Video unavailable").
- **WARP exits in the runner's country (US)**, so Israel-only YouTube videos fail with "not made this video available in
  your country". A Cloudflare Tel Aviv egress passes the country check but datacenter IPs fail the bot check, so no free
  route exists; only a paid Israeli *residential* proxy (`YT_PROXY`) would.
- **A failed media download can still leave a thumbnail.** "Any file exists" then looked like success, skipped the
  fallback clients, and uploaded `.webp` thumbnails to the user's Drive. Only media extensions count as a result, leftovers
  are pruned before delivery, and a playlist keeps trying the next client until yt-dlp exits 0.
- **Exit codes:** capture yt-dlp's status with `set +e; yt-dlp ... | tee log; rc=${PIPESTATUS[0]}; set -e` - an `|| true`
  after the pipeline overwrites PIPESTATUS. `--download-archive` makes the next client skip items already finished.
- **File names:** ASCII filters delete Hebrew (`tr -cd '[:alnum:]'` -> `_1.mp4`; `--restrict-filenames` -> `1.mp4`). Use
  `--windows-filenames`; for scraped titles a Python sanitizer removing only `\ / : * ? " < > %` and control characters.
  GitHub rewrites non-ASCII release-asset names, so the no-Drive fallback gets an ASCII name and the real name goes in the
  notes.
- **Playlists:** `out/%(playlist_title|Playlist)s/%(playlist_index)02d - %(title)s.%(ext)s` (zero-padded). With Drive on,
  upload each finished item (`--exec "after_move:bash ./upload_one.sh {}"`) so a 50-video playlist never has to fit on the
  ~14 GB runner disk. The Data API's `playlists?part=snippet,contentDetails` gives title / channel / item count for
  1 unit; oEmbed has no count.

## Kan (kan.org.il)
- **The CDN is gated by the client IP's country only.** The page HTML is reachable from anywhere; the HLS segments are not.
  Fix: the `il-relay` Worker. Placement hint `azure:israelcentral` runs it in Cloudflare Tel Aviv with an IL egress IP;
  `aws:il-central-1` landed in ZDM (geolocated "PS") and `gcp:me-west1` in Mumbai, and a Durable Object with a location
  hint never ran in Israel. No forged Referer/Origin is needed (an early version forged them and was stopped by the
  safety check - it was pointless: a plain request from an Israeli IP returns 200).
- **Relay economics:** one Worker request per 2-second segment -> ~3,000 per video episode, ~1,500 for audio; the free
  plan's 100,000/day is ~30 video episodes. Audio must use `-f ba/b` (the default downloaded the video and extracted the
  audio from it).
- **Kan's search is unusable:** `/search/` is a shell filled by a third-party widget (HeyDay); its backend returned
  `{"r":[]}` for every request we could reproduce. The catalogue index is built from `/lobby/kan-box/` (2.2 MB of plain
  cards, 362 series). ~10% of poster alts are image file names (`1800X1200`, `Poster Image Small 239X360 <name>`); the real
  name is in the series page (`npawData.program`).
- **Bot protection:** Kan answers Python's urllib and Windows' `System32\curl.exe` with 403 or a 5 KB challenge page, while
  Git's curl, Linux curl and a Cloudflare Worker `fetch` get the real page.
- **Markup:** newlines and indentation sit between attributes, so every regex needs `\s+` there (one space matched
  nothing). Season pages carry an EMPTY `npawData.program` - take the first non-empty of npaw / og:title / `<title>`.
- **Episode title:** the page's JSON-LD `VideoObject.name` ("series | episode - subtitle") beats og:title.

## Reshet 13 (13tv.co.il)
- **13tv.co.il is behind an Akamai bot wall** (curl gets 403 "Access Denied" even from Israel), but its catalogue is a
  Kaltura OTT back end (`5031.frp1.ott.kaltura.com`, partner 5031) that answers `ottuser/action/anonymousLogin` - the
  session every visitor's browser opens. Series = asset type 1259, full episodes = 1268 (metas `SeriesID`,
  `SeasonNumber`, `EpisodeNumber`), and each episode carries its Kaltura `entryId` (video partner 2748741).
- **Keep OTT answers small:** `responseProfile` `KalturaOnDemandResponseProfile` with `retrievedProperties` cuts an
  episode from ~6.5 KB to ~1.7 KB (4.7 KB with `mediaFiles`, which holds the duration). `groupBy` returns no
  aggregations here, so the season list comes from two one-item queries ordered by `SeasonNumber` (`dynamicOrderBy`
  META_ASC / META_DESC). News shows have hundreds of episodes in one season: those lists take the latest 100.
- **Only HLS works.** yt-dlp's Kaltura extractor lists mp4 renditions up to 1080p, but they answer 404 everywhere (the
  first cloud test "failed" on that, not on geography). The HLS ladder goes to 720p and is AES-128 with the key served
  to any player. yt-dlp's playManifest URL ends in `protocol/http` and its cfvod URLs are signed for http (https -> 403);
  building `cdnapisec.kaltura.com/.../format/applehttp/protocol/https/a.m3u8` gives an all-https chain.
- **Newer episodes download straight from the GitHub runner** (tested 2026-09-30). Older items (in "המעברה" the first
  episodes of season 1, uploaded earlier) carry a stricter access rule that blocks the runner AND the Cloudflare relay in
  Tel Aviv (`baseEntry/action/getPlaybackContext` -> action type 1 = BLOCK, 0 sources; a home connection gets 2 sources).
  So it is not only a country check. The workflow reports these as "13 blocked" and goes on with the next episode. The
  only clean way to get them would be the user's own connection (e.g. a self-hosted runner at home).
- **"The seasons overwrote each other" (2026-10-05) was not an overwrite.** Two season runs of "המעברה" wrote into one
  folder with one running count each: season 2 gave `01`-`07`, season 1 only `09`-`11` (its first 8 items were blocked),
  and the generic "some items failed" warning did not say how many. It read as one season with holes. Since then every
  season has its own folder (`<series>/עונה N/`, numbered from 01) and the notes say "N of M items" and list them.
  Look at the run log (`file name:` / `13 blocked:` / `OK via` lines) before believing a report about Drive.
- **Blocked items do download from the home PC** (done 2026-10-05 for the 8 items of season 1): the same playManifest
  URL answers 200 there, `yt-dlp -f "bv*+ba/b" --merge-output-format mp4` works (the PC has no pycryptodomex, so the
  AES-128 stream goes through ffmpeg: one item ~6 min, no parallel fragments). They reached Drive through Google Drive
  for desktop, which is installed on the PC (not auto-started; three accounts, the project's Drive is the `G:` one:
  `G:\האחסון שלי\13\...`). rclone's `drive.file` scope does not see files that arrive this way, so a later cloud run of
  the same item would add a second file with the same name instead of replacing it.
- The OTT catalogue host (`5031.frp1.ott.kaltura.com`) sometimes resets every connection from the home PC (curl and
  urllib alike, while the video CDN keeps working); `c13_list.py` cannot be tested locally then - use a cloud run.

## Keshet 12 (mako.co.il) - not supported
- Episode pages redirect to a Radware bot wall with a CAPTCHA (`validate.perfdrive.com`), from curl and from a real
  browser, from Israel too. Getting past that would mean defeating bot protection, which this project does not do. The
  Keshet 12 YouTube channel mostly has clips, which the normal YouTube search already covers.

## Google Drive / rclone
- `scope=drive.file` (only files rclone creates). Authorize with a portable rclone and **redirect its output**: on success
  it prints the access and refresh tokens. One was displayed once; it was revoked (`POST oauth2.googleapis.com/revoke`)
  and re-issued.
- `install.sh` of rclone exits 3 when rclone is already installed -> guard with `command -v rclone`.
- `base64 -w0 conf | gh secret set` in Git Bash; a PowerShell pipe adds `\r\n` and breaks `base64 -d` on the runner.
- rclone warns that its shared Google Drive client_id **will stop working during 2026** (see `docs\TODO.md`).

## Cloudflare / GitHub plumbing
- `workflow_dispatch` returns no run id: the Worker puts a random `job_id` in the run title and finds its run by it; the
  page shows "pending" until the run is listed.
- Free Workers get 10 ms CPU per request: parse big HTML in a workflow, not in the Worker.
- `.wrangler/cache/wrangler-account.json` contains the Cloudflare account id and e-mail: keep `.wrangler/` ignored.
- Heredocs inside a workflow `run: |` block: body and terminator at the step's base indentation.
- `apt install tor` auto-starts a system tor on 9050 (only relevant if Tor is ever retried; it was dropped).
- The Worker maps GitHub 401 / 403 / 404-on-`/actions/` to readable Hebrew messages (bad token, missing scope, workflow not
  pushed).
- **Live progress from a runner:** the runner cannot reach the Worker and the in-progress job log is not readable
  through the API, so the job's prerelease is the mailbox: created at the start of Download, its notes patched every
  5 s with yt-dlp's latest `--progress-template` line (~720 calls/h at most, under GITHUB_TOKEN's 1000/h). yt-dlp
  writes progress to stdout, so the line is picked out of the pipe (`show()`), not from the log, and `--progress-delta`
  keeps the console quiet. Fast items (a 5 MB mp3) finish between two reports: only the post-processing steps show.
