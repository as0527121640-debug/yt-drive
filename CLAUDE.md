# yt-drive

Personal site: search YouTube, Kan (kan.org.il) or Reshet 13 (13tv.co.il) - or paste a link - and the video / audio lands
in the user's Google Drive. Keshet 12 (mako) is not possible (bot wall with CAPTCHA, see `docs\LESSONS.md`). Free tiers only: a Cloudflare Worker is the always-on front door, a GitHub Actions workflow does the downloading
(yt-dlp + rclone). This folder is its own project (own repo, own tooling, own docs); it does not depend on
`C:\apk-lab`. The reusable pattern behind it is the user-level skill `cloud-job-site`
(`~\.claude\skills\cloud-job-site`, generalised lessons in its `references\youtube-to-drive.md`).

## Live
| | |
|---|---|
| Site (password login, works from any device) | https://yt-drive.moovitdos.workers.dev - Worker `yt-drive`, code in `worker\` |
| Kan relay | https://il-relay.moovitdos.workers.dev - Worker `il-relay`, code in `relay\`, runs in Cloudflare Tel Aviv |
| Repo (**PUBLIC**) | https://github.com/as0527121640-debug/yt-drive |
| Downloader | `.github\workflows\yt-drive.yml`; daily Kan index refresh: `.github\workflows\kan-index.yml` |

## Read first
- `docs\ARCHITECTURE.md` - data flow, API, workflow inputs, secrets and variables (names only), Drive layout, limits.
- `docs\OPERATIONS.md` - setup from zero, deploy, test recipes, troubleshooting, maintenance.
- `docs\LESSONS.md` - what broke and why (YouTube bot check, Kan geo-gating, playlists, file names, rclone, Cloudflare).
- `docs\TODO.md` - open items, and what has NOT been live-tested yet.

## Layout
| Path | What |
|---|---|
| `worker\` | the site Worker: `src\index.js` (auth, search, previews, Kan index/episodes, 13 catalogue via Kaltura OTT, job dispatch/status), `public\` (Hebrew RTL PWA page "לדרייב", service worker, manifest) |
| `relay\` | `il-relay`: keyed, host-allowlisted fetch relay pinned to Cloudflare Tel Aviv (Kan streams are geo-gated to Israel) |
| `.github\workflows\` | `yt-drive.yml` (download + deliver), `kan-index.yml` (daily catalogue refresh) |
| `scripts\` | `build_kan_index.py`, `check.py` (static checks), `dev.mjs` (local dev server), `wr.mjs` (runs this project's wrangler in worker/ or relay/) |
| `data\kan-index.json` | 362 Kan series (title, url, poster); built by the workflow, read by the Worker from raw.githubusercontent.com |
| `docs\` | see above |
| `.local\` | git-ignored: `relay.key` (copy of RELAY_KEY for manual relay tests) |

## Commands (from this folder; needs Node + Python; first time `npm install`)
```
npm run check                      static checks: JS syntax, YAML + bash -n of every workflow step, embedded scripts, index
npm run dev                        local site at http://localhost:8787 (password: test; creates worker\.dev.vars with test values)
npm run deploy:site                deploy the site Worker (page + API)
npm run deploy:relay               deploy the Kan relay
npm run wr -- site secret list     any wrangler command in worker\ ("site") or relay\ ("relay")
gh workflow run yt-drive.yml -R as0527121640-debug/yt-drive -f input=<url> -f format=audio -f job_id=test0001
gh run watch <id> -R as0527121640-debug/yt-drive      then:  gh release view job-test0001 -R ... --json body --jq .body
```
Workflow changes take effect on `git push`; Worker / page changes need `npm run deploy:site`. Test inputs and the full
recipe are in `docs\OPERATIONS.md`.

## Rules
1. **The repo is PUBLIC.** Never commit a secret, token, cookie, `rclone.conf`, Cloudflare account id or e-mail. Run
   `git status` before every commit. (Once `relay/.wrangler/cache/wrangler-account.json` - account id + e-mail - slipped
   in; it is untracked and ignored now but still sits in commit `96c4cde`.)
2. **Secrets are typed by the user in their own terminal** (open a PowerShell window with the prompts: `wrangler secret
   put`, `gh secret set`). Never ask them to paste one into the chat, never print one. Redirect the output of any command
   that may print a config (`rclone config create ... *> log`) - a Drive refresh token once appeared in the chat that
   way; it was revoked and re-issued.
3. **Nothing in the user's Google Drive is deleted without their explicit OK.** Test runs put real files there: list them
   to the user afterwards (`docs\TODO.md` keeps the list of known test/stray files).
4. **The relay is not an open proxy:** shared key + allowlist (kan.org.il, cdn-redge.media, kaltura.com). Do not widen the
   allowlist and do not forge Referer/Origin - Kan's CDN only checks the client IP's country, and the relay simply runs
   where the user is (Israel).
5. **Prove every change with one real run** on a short item before calling it done, and say plainly what was tested and
   what was not. Static checks first (`npm run check`), then locally, then one cloud run.
6. **The user writes Hebrew: answer in Hebrew** (tool names, commands and paths stay English), including short status
   updates. Work solo (no subagents unless asked). The PC has 8 GB RAM - one heavy local step at a time.

## Gotchas on this Windows box
- Python does not understand Git-Bash's `/tmp`; use `C:/Users/a0527/AppData/Local/Temp/...` when a script reads a file.
- Kan answers Python's urllib and `C:\Windows\System32\curl.exe` with 403 / a 5 KB challenge page; Git's curl, Linux curl
  and a Worker `fetch` work (`CURL_BIN` env override in the scripts).
- `wrangler dev` leaves `workerd` processes: stop them afterwards and delete `worker\.dev.vars` and `.wrangler\`.
- In the workflow, heredoc bodies inside `run: |` sit at the step's base indentation (terminator at column 0 after YAML
  dedent). Capture yt-dlp's exit code with `set +e; ... | tee log; rc=${PIPESTATUS[0]}; set -e`.
- Working directory of a Claude session is fixed when it starts: open the session **in this folder** to work on this
  project (user memory for it lives in `~\.claude\projects\C--yt-drive\memory`).

## State lives elsewhere
Nothing important is local. State is in GitHub (runs, `job-*` releases, repo secrets and variables) and Cloudflare
(Worker secrets); the user's Drive holds the results. To resume: `git pull`, `gh run list -R as0527121640-debug/yt-drive
-L 5`, read `docs\TODO.md`.
