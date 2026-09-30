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
   test, season 2 episodes 1-2).
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
- The **redesigned page on the live site** (tested locally at phone width, light and dark; job cards only with example data).
- Failure paths: a playlist with removed / private items (the "some items failed" warning), Kan season with a failing
  episode.

## Ideas (nobody asked yet)
- Search inside Kan episodes (today the search is by series title only).
- A "retry" button on a failed job; a page listing what is in Drive.
- Show the Worker-request budget of the relay before a large Kan download.
