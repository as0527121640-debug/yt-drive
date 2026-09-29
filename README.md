# yt-drive

Search YouTube and send a video (MP4) or audio (MP3) straight to Google Drive — from any device.

- **Front door:** a Cloudflare Worker (`worker/`) — an always-on, password-protected page. It holds the secrets and
  runs the search (YouTube Data API); the browser never sees a token.
- **Muscle:** a GitHub Actions workflow (`.github/workflows/yt-drive.yml`) that runs `yt-dlp` and, if `rclone` is
  configured, uploads the result to Google Drive. Public repo = unlimited Actions minutes.

Built with the `cloud-job-site` pattern. Personal-use tool.

## Setup
1. Worker: `cd worker && npx wrangler deploy`, then set secrets `APP_PASSWORD`, `GH_TOKEN` (fine-grained: Actions +
   Contents write on this repo), `YT_API_KEY` (YouTube Data API v3).
2. Drive (optional): set repo secret `RCLONE_CONF_BASE64` (base64 of an rclone.conf with a `gdrive:` remote); without
   it, results download from the site instead.
