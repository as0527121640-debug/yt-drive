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
