# downloader

**Pluck** — paste a link, get the video file. A static page (`index.html`) plus a Cloudflare Worker (`worker.js`).

## What it can download

| Link | How | Setup needed |
| --- | --- | --- |
| X / Twitter posts | X's public embed API | none |
| YouTube (videos, Shorts), TikTok, Instagram, Reddit, Vimeo and [many more](https://github.com/imputnet/cobalt#supported-services) | a [cobalt](https://github.com/imputnet/cobalt) instance | `COBALT_API` |
| Direct video links (`.mp4`, `.webm`, `.mov`, …) and pages that embed a video file (`og:video`, `<video>`, JSON-LD) | the worker reads the page | none (`SIGNING_KEY` recommended) |

YouTube gets 1080p, 720p, 360p and an audio-only MP3. Streaming-only video (HLS/DASH playlists) and live streams can't be saved as one file.

## Setup

1. Create a Cloudflare Worker and paste in `worker.js`.
2. In the Worker's **Settings → Variables and Secrets**, optionally add:
   - `COBALT_API` — URL of a cobalt instance, e.g. `https://cobalt.example.com`. YouTube needs this. The public `api.cobalt.tools` only accepts requests from its own site, so [host your own](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md) or use an instance that gives you an API key.
   - `COBALT_API_KEY` — that instance's API key, if it requires one.
   - `SIGNING_KEY` — any long random string. Lets the worker serve files from other sites as a proper download (with a filename) while refusing to proxy links it didn't hand out. Without it, those files are linked to directly.
3. In `index.html`, set `WORKER` to your Worker's URL, then host the page anywhere (GitHub Pages works).

You can pre-fill the page with `?url=<link>`, e.g. from an iOS Shortcut.

Only download videos you have the right to save.
