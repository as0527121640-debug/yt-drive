# Operations

Commands assume this folder as the working directory, Node + Python installed, `gh` logged in to the account that owns
the repo (`as0527121640-debug`).

## Set up from zero
1. `npm install` (installs this project's own wrangler; nothing is borrowed from another project).
2. Log in to Cloudflare: `npm run wr -- site login` (browser opens, click Allow; the OAuth prompt times out after a few
   minutes - if you must sign up or verify e-mail first, do that, then run it again). Check: `npm run wr -- site whoami`.
3. Deploy both Workers: `npm run deploy` (the site first prints "not configured yet" until the secrets exist).
4. **Worker secrets - typed by the user in their own terminal** (open a PowerShell window for them, they paste with a
   right click, nothing echoes):
   ```
   npm run wr -- site secret put APP_PASSWORD     # a password they choose
   npm run wr -- site secret put GH_TOKEN         # fine-grained PAT, only this repo, Actions RW + Contents RW
   npm run wr -- site secret put YT_API_KEY       # Google Cloud: enable "YouTube Data API v3", create an API key
   npm run wr -- relay secret put RELAY_KEY       # any long random string; must equal the repo secret below
   ```
5. GitHub repo secrets / variables (same rule for secret values):
   ```
   gh secret set RELAY_KEY -R as0527121640-debug/yt-drive
   gh variable set RELAY_URL --body https://il-relay.moovitdos.workers.dev -R as0527121640-debug/yt-drive
   gh secret set RCLONE_CONF_BASE64 -R as0527121640-debug/yt-drive     # see "Google Drive" below
   ```
6. Build the Kan index once: `gh workflow run kan-index.yml -R as0527121640-debug/yt-drive` (it then refreshes daily).
7. Prove it end to end: one short run from the site (or the test recipes below).

### Google Drive (rclone) - the one step that needs a browser on the PC
Full step-by-step with the reasons: `~\.claude\skills\cloud-job-site\references\youtube-to-drive.md`, section "One-time: an
rclone config". Short version, done live and working: download the **portable** rclone zip from downloads.rclone.org and
check its SHA256 (ask the user before downloading), run `rclone config create gdrive drive scope=drive.file --config
<temp>\rclone.conf` **with all output redirected to a file** (it prints the tokens on success), the user clicks Allow in
the browser, verify with `rclone --config ... lsf gdrive:`, store with `base64 -w0 <conf> | gh secret set
RCLONE_CONF_BASE64 -R ...` (Git Bash - a PowerShell pipe adds `\r\n`), delete the temp folder.
`drive.file` = rclone can only touch files it created, never the rest of the Drive.

## Daily work
- Edit -> `npm run check` -> commit -> push. **Workflow edits are live on push.** Worker / page edits also need
  `npm run deploy:site` (relay edits: `npm run deploy:relay`).
- Local UI: `npm run dev` (http://localhost:8787, password `test`). Kan search, episode lists and link previews work with
  real data; job dispatch does not (fake GitHub token, on purpose); YouTube search needs a real key in `worker\.dev.vars`.
  Stop `workerd` afterwards and delete `worker\.dev.vars` + `.wrangler\`.
- Watch a run: `gh run list -R as0527121640-debug/yt-drive -L 5`, `gh run watch <id> -R ... --exit-status`, logs:
  `gh run view <id> -R ... --log` (filter with `sed 's/^[^\t]*\t[^\t]*\t[^ ]* //' | grep ...`).

## Test recipes (short items; runs upload REAL files to the user's Drive - tell them what landed)
| What | Input | Options | Takes |
|---|---|---|---|
| video / audio | `https://www.youtube.com/watch?v=jNQXAC9IVRw` (19 s) | `format=audio` or `video quality=480` | ~1 min |
| playlist | `https://www.youtube.com/playlist?list=PLOGi5-fAu8bEm4DqzTayOzmf6yOu0P-pQ` (TED-Ed) | `playlist=yes max_items=3 format=audio` | ~3 min |
| Kan episode | `https://www.kan.org.il/content/kan/kan-11/p-12845/s1/134630/` | `format=audio` | ~7 min |
| Kan season | `https://www.kan.org.il/content/kan/kan-11/p-12845/s1/` | `playlist=yes max_items=2 format=audio` | ~14 min |
| 13 episode | `https://13tv.co.il/allshows/series/718/season/2/4591934/` (46 min) | `format=audio` | ~5 min |
| 13 season | `https://13tv.co.il/allshows/series/718/season/2/` | `playlist=yes max_items=2 format=audio` | ~8 min |
| 13 blocked item (expect a clear "13 blocked" reason) | `https://13tv.co.il/allshows/series/718/season/1/4315562/` | `format=audio` | ~2 min |
```
gh workflow run yt-drive.yml -R as0527121640-debug/yt-drive -f input=<url> -f format=audio -f playlist=yes -f max_items=3 -f job_id=test0001
gh release view job-test0001 -R as0527121640-debug/yt-drive --json body --jq .body     # source / delivered / files
gh release view job-test0001 -R as0527121640-debug/yt-drive --json body --jq .body | grep ^progress:   # while it runs: live progress line
```
A good result says `delivered: Google Drive / <folder> (N file(s))` and lists real media names (no `.webp`).

## Troubleshooting
| Symptom | Likely cause | What to do |
|---|---|---|
| Site: "server not configured yet" | Worker secrets missing | `npm run wr -- site secret list`; set APP_PASSWORD / GH_TOKEN |
| Site: "GitHub token invalid or expired" | fine-grained PAT expired or lost a scope | new PAT (this repo only, Actions RW + Contents RW), `secret put GH_TOKEN` |
| Site: "YouTube key invalid / quota" | YT_API_KEY wrong, API not enabled, or 10,000 units spent (resets midnight Pacific) | fix the key / wait; pasting a link still works |
| Run fails in Download: "Sign in to confirm you're not a bot" | WARP did not come up, or YouTube flagged its IP | look for `WARP up: ... warp=on` in the "Start Cloudflare WARP" step; retry later; optional `YT_COOKIES` |
| Download: `HTTP Error 403` on the media | transient YouTube refusal for that client | the chain tries the other clients / routes; a later retry usually works |
| "not made this video available in your country" | Israel-only YouTube content; WARP exits in the US | only a paid Israeli residential proxy (`YT_PROXY`) helps; Kan content is different - use the Kan tab / a kan.org.il link |
| Kan: "could not find the Kan stream" | the link is a page without a video (article, empty series) | use an episode / season / series link from the Kan tab |
| Kan download 403 / hangs | relay key mismatch, relay not deployed, or the daily 100k Worker-request quota is spent | `curl https://il-relay.moovitdos.workers.dev/health` must answer `{"ok":true,"colo":"TLV"}`; compare RELAY_KEY (Worker vs repo secret) |
| Kan tab: "index not created yet" or an old catalogue | `data/kan-index.json` missing / stale | `gh workflow run kan-index.yml -R ...` |
| Drive upload fails with an auth error | rclone token revoked, or rclone's shared client_id was retired | re-authorize (section "Google Drive") - and do the own-OAuth-client item in `docs\TODO.md` |
| Job shows "pending" for a few seconds | `workflow_dispatch` returns no run id; the page finds its run by the job id in the run title | normal |
| A run failed midway through a playlist | items finished before the failure are already in Drive | rerun; `--download-archive` is per run, so finished items are downloaded again (Drive overwrites same names) |

## Maintenance
- yt-dlp: installed fresh from pip on every run, nothing to do. Kan index: daily. `job-*` releases: cleaned after 14 days.
- Watch the expiry of `GH_TOKEN`. Keep `RELAY_KEY` identical in the relay Worker and the repo secret.
- If YouTube changes something and every download fails: read the run log first (`Download` step), then the yt-dlp
  issue tracker; the fallback chain (clients x routes) usually shows which layer broke.
- Rotating the relay key: new random string -> `npm run wr -- relay secret put RELAY_KEY`, `gh secret set RELAY_KEY`,
  update `.local\relay.key`.
