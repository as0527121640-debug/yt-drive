# yt-drive

Search YouTube or Kan (kan.org.il) - or paste a link - and send the video or audio straight to Google Drive, from any
device. Runs entirely on free tiers; nothing runs (or costs) while idle. Personal-use tool.

## What it does
- **YouTube:** search videos and playlists, or paste a link. Choose MP4 (best / 1080p / 720p / 480p) or MP3. A playlist link
  downloads the playlist (first 10 / 25 / 50 / 100 items), each item saved to Drive as it finishes.
- **Kan:** search the catalogue by series name, browse seasons and episodes, download one episode or a whole season.
  Kan streams are licensed for Israel, so they are fetched through a small relay that runs in Cloudflare's Tel Aviv data
  center.
- **Site:** Hebrew, right-to-left, phone-first, dark "TV screen" look, installable (PWA) with an Android "Share" target, live job
  progress, password protected.

## How it works
```
browser --> Cloudflare Worker (site + API, holds the secrets) --> GitHub Actions workflow (yt-dlp + rclone) --> Google Drive
                                                                        |
                                                                        +--> Cloudflare WARP (YouTube) / il-relay Worker in Tel Aviv (Kan)
```
Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md). What broke and why:
[`docs/LESSONS.md`](docs/LESSONS.md). Open items: [`docs/TODO.md`](docs/TODO.md).

## Layout
| Path | |
|---|---|
| `worker/` | the site: `src/index.js` (API) and `public/` (page, service worker, manifest) |
| `relay/` | `il-relay`, the Tel Aviv fetch relay for Kan |
| `.github/workflows/` | `yt-drive.yml` (download + deliver), `kan-index.yml` (daily catalogue refresh) |
| `scripts/` | `build_kan_index.py`, `check.py`, `dev.mjs`, `wr.mjs` |
| `data/kan-index.json` | the Kan series index the Worker searches |

## Quick start
```
npm install                # this project's own wrangler
npm run check              # static checks (JS syntax, workflow YAML + bash -n, embedded scripts, index)
npm run dev                # local site at http://localhost:8787 (password: test)
npm run deploy             # deploy the site Worker and the relay
```
First-time setup (Cloudflare login, Worker secrets, GitHub secrets, Google Drive authorization) is in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md). Claude Code instructions for working on this project: [`CLAUDE.md`](CLAUDE.md).

## Notes
- This repository is public on purpose (unlimited GitHub Actions minutes). It contains no secrets: tokens, keys and the
  rclone config live in Cloudflare Worker secrets and GitHub repository secrets. Run and release titles do show what was
  downloaded.
- Built with the `cloud-job-site` pattern (Cloudflare Worker front door + GitHub Actions muscle).
