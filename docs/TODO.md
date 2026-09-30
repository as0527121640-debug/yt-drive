# Open items

## Needs doing
1. **Own Google OAuth client for rclone.** rclone's shared Drive client_id is being retired "during 2026"; uploads will
   start failing with an auth error. Google Cloud Console -> OAuth consent screen -> publish to Production (`drive.file`
   is a non-sensitive scope: no verification; in *Testing* status refresh tokens die after 7 days) -> create a Desktop
   OAuth client -> re-run the rclone authorization with `client_id=... client_secret=...` -> replace the repo secret
   `RCLONE_CONF_BASE64`. (The Google Cloud project with the YouTube key already exists.)
2. **Files from test runs in the user's Drive** (never delete without asking): `YouTube/Me_at_the_zoo.mp4`;
   `YouTube/Most popular TED-Ed animations of 2025/` (3 mp3 from tests **plus 3 stray `.webp` thumbnails** uploaded by a
   bug that is fixed now); `YouTube/עלומים/01 - ...mp3`, `02 - ...mp3` (season test, before Kan got its own folder);
   `Kan/עלומים - פרק 2 - ילד, חסר לך משהו.mp3`; `YouTube/עלומים - פרק 1 - ...mp3` (early Kan test);
   `13/המעברה, עונה 2, פרק 7 שן תחת שן.mp3` (first 13 test, 2026-09-30); `13/המעברה/01 - ...mp3`, `02 - ...mp3` (13 season
   test, season 2 episodes 1-2). The progress tests (prog0001-0004, 2026-09-30) only re-wrote the 3 TED-Ed mp3 and the
  13 episode mp3 above - no new files.
3. **Israel-only YouTube videos** cannot be downloaded for free (see `docs\LESSONS.md`). If it matters: a paid Israeli
   residential proxy as repo secret `YT_PROXY` (already supported, nothing to change in code).

4. **Older 13 episodes are blocked** for the runner and the relay alike (see `docs\LESSONS.md`). Clean option if it
   matters: a self-hosted GitHub runner on a PC at home in Israel for 13 jobs only (the PC must be on).
5. **Keshet 12 (mako)** is not supported: Radware bot wall with a CAPTCHA on every episode page.

## Not live-tested yet (code exists, checked statically / locally / with mock data)
- **Video (not audio) playlists** and playlists of more than 3 items.
- **Kan video seasons** (episode ~1 GB each; uploaded one by one) - only audio seasons were run in the cloud.
- The **Kan tab clicked through on the live site** (tested locally on real Kan data and phone width; the live site needs
  the user's password).
- The **"whole playlist" checkbox** and the item-count line for a `watch?v=...&list=...` link with a real YouTube key
  (tested with mock data locally).
- **13 video** (only 13 audio ran in the cloud) and a **whole 13 series** link (season by season; tested locally with
  `c13_list.py` only). The **13 tab clicked through on the live site** (tested locally at phone width).
- The **library view** (Kan / 13 tabs) on the live site - tested locally on the real indexes at phone width.
- The **redesigned page ("TV" look, 2026-09-30) on the live site**: tested locally at phone and desktop width on the real 13 / Kan indexes and episode lists; the downloads drawer and job cards only with example data (the local dev server has no GitHub token). Not tested in the field: the drawer on a real phone with the keyboard open, and the rails with the Kan index (only 13 was clicked through).
- The **rebuilt downloads panel (2026-10-01)**: side column opened from the header on a wide screen, bottom sheet on the phone, compact job rows with a "details" toggle. Tested locally at 1248 / 920 / 375 px with example jobs (running with percent, saving to Drive, queued, saved, saved with warning, failed, release file, cancelled) and real open / close clicks (header button, close button, Esc, bottom bar). Deployed; the live page serves the new code. Not seen yet with the real job list of the live site (needs the user's password).
- Failure paths: a playlist with removed / private items (the "some items failed" warning), Kan season with a failing
  episode.
- **Live progress** (2026-09-30): proved in the cloud on a 13 episode (percent, size, speed, ETA, then "ExtractAudio")
  and seen on a real Kan video season (43%, 960 MB of 2.18 GB). Not seen live yet: the "item n of m" counter for
  YouTube playlists (the test run hit YouTube's bot check on every route - unrelated to progress) and the page itself
  polling a running job (needs the user's password; the parser was unit-tested on the real lines). One 13 run
  (prog0002) got `HTTP 403 Resource not accessible by integration` on every release call from GITHUB_TOKEN while the
  runs before and after it, on the same commit, were fine; the re-run passed. If it repeats, suspect GitHub, not the
  workflow.

## Ideas (nobody asked yet)
- Search inside Kan episodes (today the search is by series title only).
- A "retry" button on a failed job; a page listing what is in Drive.
- Show the Worker-request budget of the relay before a large Kan download.
