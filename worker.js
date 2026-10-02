// Pluck — Cloudflare Worker
// Paste this whole file into a Cloudflare Worker and deploy.
//
// Endpoints:
//   GET /info?url=<link>   -> JSON list of downloadable video files
//   GET /dl?u=<file url>&name=<filename>[&sig=<signature>]  -> streams the file as a download
//
// Supported links:
//   - X / Twitter posts            (built in, no setup)
//   - YouTube + many other sites   (needs a cobalt instance, see COBALT_API below)
//   - Any other page or file link  (direct .mp4/.webm links, or pages that embed a
//                                    video file via og:video, <video>, or JSON-LD)
//
// Optional Worker settings (Settings -> Variables and Secrets):
//   COBALT_API      URL of a cobalt instance, e.g. https://cobalt.example.com
//                   (https://github.com/imputnet/cobalt). Required for YouTube,
//                   TikTok, Instagram, Reddit, Vimeo, etc.
//   COBALT_API_KEY  API key for that instance, if it needs one.
//   SIGNING_KEY     Any long random string. Lets /dl proxy files from sites other
//                   than X as a proper download, without being an open proxy.
//                   Without it, files from other sites are linked to directly.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function safeName(s) {
  return (s || 'video').replace(/[^\w.-]/g, '_').replace(/_+/g, '_').slice(0, 80);
}

function parseLink(input) {
  const s = (input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

// ---------- download link signing ----------

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isTwimg(u) {
  try { const t = new URL(u); return t.protocol === 'https:' && t.hostname === 'video.twimg.com'; } catch { return false; }
}

// Returns a link to download `fileUrl`: a worker-relative /dl path when the worker
// can proxy it, otherwise the file URL itself.
async function downloadLink(env, fileUrl, name) {
  const q = `u=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(safeName(name))}`;
  if (isTwimg(fileUrl)) return `/dl?${q}`;
  if (env.SIGNING_KEY) return `/dl?${q}&sig=${await hmac(env.SIGNING_KEY, fileUrl)}`;
  return fileUrl;
}

// ---------- X / Twitter ----------

function tweetIdFrom(link, raw) {
  if (/^\d{5,25}$/.test((raw || '').trim())) return raw.trim();
  if (!link || !/(^|\.)(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/i.test(link.hostname)) return null;
  const m = link.pathname.match(/status(?:es)?\/(\d{5,25})/);
  return m ? m[1] : null;
}

// Same token the official embed widget uses
function tokenFor(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function collectTweetVideos(tweet) {
  const out = [];
  const sources = [tweet, tweet.quoted_tweet].filter(Boolean);
  for (const t of sources) {
    for (const m of t.mediaDetails || []) {
      if (m.type !== 'video' && m.type !== 'animated_gif') continue;
      const variants = (m.video_info?.variants || [])
        .filter(v => v.content_type === 'video/mp4')
        .map(v => {
          const r = v.url.match(/\/(\d+)x(\d+)\//);
          return {
            url: v.url,
            bitrate: v.bitrate || 0,
            width: r ? Number(r[1]) : null,
            height: r ? Number(r[2]) : null,
            ext: 'mp4',
          };
        })
        .sort((a, b) => b.bitrate - a.bitrate);
      if (variants.length) {
        out.push({
          type: m.type === 'animated_gif' ? 'gif' : 'video',
          thumb: m.media_url_https,
          durationMs: m.video_info?.duration_millis || null,
          fromQuote: t !== tweet,
          preview: variants[0].url,
          variants,
        });
      }
    }
  }
  return out;
}

async function infoFromX(id, env) {
  const api = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${tokenFor(id)}`;
  const r = await fetch(api, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pluck/1.0)' },
    cf: { cacheTtl: 300 },
  });

  if (!r.ok) throw new UserError(`X didn’t return this post (status ${r.status}). It may be deleted, private, or marked sensitive.`, 502);

  const text = await r.text();
  if (!text) throw new UserError('X returned nothing for this post. It may be private, deleted, or age-restricted.', 404);

  let tweet;
  try { tweet = JSON.parse(text); } catch { throw new UserError('X returned something unreadable. Try again in a minute.', 502); }

  if (tweet.__typename === 'TweetTombstone') {
    throw new UserError('This post is unavailable — usually deleted, protected, or age-restricted.', 404);
  }

  const videos = collectTweetVideos(tweet);
  if (!videos.length) throw new UserError('No video or GIF found in this post.', 404);

  const user = tweet.user?.screen_name || 'x';
  for (const [n, vid] of videos.entries()) {
    for (const v of vid.variants) {
      const q = v.width && v.height ? Math.min(v.width, v.height) + 'p' : '';
      v.label = q;
      v.dl = await downloadLink(env, v.url, [user, id, videos.length > 1 ? n + 1 : '', q].filter(Boolean).join('_'));
    }
  }

  return {
    source: 'X',
    id,
    title: tweet.user?.name ? `${tweet.user.name} @${user}` : `@${user}`,
    text: (tweet.text || '').replace(/https:\/\/t\.co\/\S+$/, '').trim(),
    videos,
  };
}

// ---------- YouTube & friends, via cobalt ----------

function youtubeIdFrom(link) {
  if (!link) return null;
  const h = link.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (h === 'youtu.be') return link.pathname.slice(1, 12) || null;
  if (h !== 'youtube.com' && h !== 'youtube-nocookie.com') return null;
  const v = link.searchParams.get('v');
  if (v) return v.slice(0, 11);
  const m = link.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

const COBALT_ERRORS = {
  'error.api.link.invalid': 'cobalt doesn’t recognise this link.',
  'error.api.link.unsupported': 'This site isn’t supported by cobalt.',
  'error.api.content.video.unavailable': 'This video is unavailable.',
  'error.api.content.video.private': 'This video is private.',
  'error.api.content.video.age': 'This video is age-restricted.',
  'error.api.content.video.live': 'Live streams can’t be downloaded.',
  'error.api.content.video.region': 'This video is blocked in the server’s region.',
  'error.api.content.too_long': 'This video is too long for the cobalt server.',
  'error.api.fetch.fail': 'cobalt couldn’t fetch this video. Try again in a minute.',
  'error.api.fetch.empty': 'cobalt found nothing to download here.',
  'error.api.rate_exceeded': 'The cobalt server is rate-limiting requests. Try again shortly.',
  'error.api.auth.key.missing': 'The cobalt server needs an API key (set COBALT_API_KEY).',
  'error.api.auth.key.invalid': 'The cobalt API key was rejected (check COBALT_API_KEY).',
  'error.api.auth.jwt.missing': 'This cobalt server only accepts requests from its own website. Use another instance or an API key.',
};

async function cobalt(env, url, opts) {
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (env.COBALT_API_KEY) headers.Authorization = `Api-Key ${env.COBALT_API_KEY}`;
  const r = await fetch(env.COBALT_API.replace(/\/+$/, '') + '/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, filenameStyle: 'pretty', youtubeVideoCodec: 'h264', ...opts }),
  });
  const data = await r.json().catch(() => null);
  if (!data) throw new UserError(`The cobalt server sent back something unreadable (status ${r.status}).`, 502);
  if (data.status === 'error') {
    const code = data.error?.code || '';
    throw new UserError(COBALT_ERRORS[code] || `cobalt couldn’t handle this link (${code || r.status}).`, 502);
  }
  return data;
}

async function infoFromCobalt(link, env) {
  const url = link.toString();
  const ytId = youtubeIdFrom(link);
  const host = link.hostname.replace(/^www\./, '');

  // Ask for a few versions at once; cobalt only does the work when a link is opened.
  const asks = ytId
    ? [
        { label: '1080p', ext: 'mp4', opts: { videoQuality: '1080' } },
        { label: '720p', ext: 'mp4', opts: { videoQuality: '720' } },
        { label: '360p', ext: 'mp4', opts: { videoQuality: '360' } },
        { label: 'Audio only', ext: 'mp3', opts: { downloadMode: 'audio', audioFormat: 'mp3' } },
      ]
    : [
        { label: 'Best', ext: 'mp4', opts: { videoQuality: 'max' } },
        { label: 'Audio only', ext: 'mp3', opts: { downloadMode: 'audio', audioFormat: 'mp3' } },
      ];

  const settled = await Promise.allSettled(asks.map(a => cobalt(env, url, a.opts)));
  const first = settled.find(s => s.status === 'fulfilled')?.value;
  if (!first) throw settled[0].reason;

  // Posts with several items (Instagram carousels, TikTok slideshows, …)
  if (first.status === 'picker') {
    const videos = (first.picker || [])
      .filter(p => p.type === 'video' || p.type === 'gif')
      .map(p => ({
        type: p.type,
        thumb: p.thumb || null,
        preview: p.url,
        variants: [{ url: p.url, dl: p.url, label: 'Best', ext: 'mp4' }],
      }));
    if (!videos.length) throw new UserError('This post only has photos, no video.', 404);
    return { source: host, id: ytId || host, title: host, text: '', videos };
  }

  const variants = [];
  const seen = new Set();
  settled.forEach((s, i) => {
    const d = s.status === 'fulfilled' ? s.value : null;
    if (!d?.url || (d.status !== 'tunnel' && d.status !== 'redirect')) return;
    // cobalt hands back the same file when the video is already smaller than the ask
    const key = d.filename || d.url;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({ url: d.url, dl: d.url, label: asks[i].label, ext: asks[i].ext, filename: d.filename || '' });
  });
  if (!variants.length) throw new UserError('cobalt found nothing to download for this link.', 404);

  const title = (variants[0].filename || '').replace(/\s*\([^)]*\)\s*\.\w+$|\.\w+$/, '').trim();
  return {
    source: ytId ? 'YouTube' : host,
    id: ytId || host,
    title: title || host,
    text: '',
    videos: [{
      type: 'video',
      // Previewing a tunnel would start the whole conversion, so show a still instead
      thumb: ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null,
      preview: null,
      variants,
    }],
  };
}

// ---------- Any other link: direct files and pages with embedded video ----------

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)(?:[?#]|$)/i;

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (_, e) => {
    const map = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'gi');
    for (const tag of html.match(re) || []) {
      const c = tag.match(/content=["']([^"']+)["']/i);
      if (c) return decodeEntities(c[1]);
    }
  }
  return null;
}

function findVideoUrls(html, base) {
  const found = [];
  const add = raw => {
    if (!raw) return;
    try {
      const u = new URL(decodeEntities(raw.replace(/\\\//g, '/')), base);
      if (/^https?:$/.test(u.protocol) && !found.includes(u.href)) found.push(u.href);
    } catch {}
  };

  // Open Graph / Twitter card video tags
  for (const tag of html.match(/<meta[^>]+>/gi) || []) {
    if (/(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["']/i.test(tag)) {
      add(tag.match(/content=["']([^"']+)["']/i)?.[1]);
    }
  }
  // <video src> and <source src>
  for (const tag of html.match(/<(?:video|source)\b[^>]*>/gi) || []) {
    add(tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]);
  }
  // JSON-LD VideoObject
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)) add(m[1]);
  // Bare links to video files anywhere in the page
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^\s"'<>]+?\.(?:mp4|m4v|webm|mov)(?:\?[^\s"'<>]*)?(?=["'\s<>])/gi)) add(m[0]);

  // Only keep links that look like files we can save (skip HLS/DASH playlists and embeds)
  return found.filter(u => VIDEO_EXT.test(new URL(u).pathname));
}

async function infoFromPage(link, env) {
  const r = await fetch(link.toString(), {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,video/*;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (!r.ok) throw new UserError(`That page didn’t load (status ${r.status}).`, 502);

  const finalUrl = r.url || link.toString();
  const type = (r.headers.get('content-type') || '').toLowerCase();
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');

  // The link is the video file itself
  if (type.startsWith('video/') || (type.includes('octet-stream') && VIDEO_EXT.test(finalUrl))) {
    r.body?.cancel();
    const file = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || 'video');
    const ext = (file.match(/\.(\w+)$/)?.[1] || type.split('/')[1] || 'mp4').toLowerCase();
    const name = file.replace(/\.\w+$/, '');
    return {
      source: host,
      id: name,
      title: file,
      text: '',
      videos: [{
        type: 'video',
        thumb: null,
        preview: finalUrl,
        variants: [{ url: finalUrl, dl: await downloadLink(env, finalUrl, name), label: 'Original', ext }],
      }],
    };
  }

  if (!type.includes('html')) throw new UserError('That link isn’t a video or a web page.', 415);

  const html = (await r.text()).slice(0, 3_000_000);
  const urls = findVideoUrls(html, finalUrl);
  if (!urls.length) {
    const hint = env.COBALT_API ? '' : ' For sites like YouTube, TikTok or Instagram, the server needs a cobalt instance (COBALT_API).';
    throw new UserError(`Couldn’t find a downloadable video file on that page. It may use streaming that can’t be saved as one file.${hint}`, 404);
  }

  const title = metaContent(html, ['og:title', 'twitter:title']) ||
    decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim() || host;
  let thumb = metaContent(html, ['og:image', 'twitter:image']);
  try { thumb = thumb ? new URL(thumb, finalUrl).href : null; } catch { thumb = null; }
  const base = safeName(title).slice(0, 60);

  const videos = [];
  for (const [n, u] of urls.slice(0, 10).entries()) {
    const ext = (new URL(u).pathname.match(VIDEO_EXT)?.[1] || 'mp4').toLowerCase();
    videos.push({
      type: 'video',
      thumb,
      preview: u,
      variants: [{ url: u, dl: await downloadLink(env, u, urls.length > 1 ? `${base}_${n + 1}` : base), label: 'Original', ext }],
    });
  }
  return { source: host, id: host, title, text: metaContent(html, ['og:description', 'description']) || '', videos };
}

// ---------- routes ----------

async function handleInfo(url, env) {
  const raw = url.searchParams.get('url');
  const link = parseLink(raw);
  const tweetId = tweetIdFrom(link, raw);
  if (tweetId) return json(await infoFromX(tweetId, env));
  if (!link) throw new UserError('That doesn’t look like a link. Paste a full web address.');

  const isYouTube = !!youtubeIdFrom(link);
  if (env.COBALT_API) {
    try {
      return json(await infoFromCobalt(link, env));
    } catch (e) {
      // cobalt is the only way to do YouTube; for anything else, try reading the page ourselves
      if (isYouTube) throw e;
      try { return json(await infoFromPage(link, env)); } catch { throw e; }
    }
  }
  if (isYouTube) {
    throw new UserError('YouTube needs a cobalt server. Set COBALT_API on the Worker (see the README).', 501);
  }
  return json(await infoFromPage(link, env));
}

async function handleDownload(url, env) {
  let target;
  try { target = new URL(url.searchParams.get('u')); } catch { return new Response('Bad url', { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(target.protocol)) return new Response('Bad url', { status: 400, headers: CORS });

  // Only X's video CDN, or links this worker signed, so it can't be used as an open proxy
  if (!isTwimg(target.toString())) {
    const sig = url.searchParams.get('sig') || '';
    if (!env.SIGNING_KEY || sig !== await hmac(env.SIGNING_KEY, target.toString())) {
      return new Response('This download link isn’t allowed', { status: 403, headers: CORS });
    }
  }

  const r = await fetch(target.toString(), { headers: { 'User-Agent': UA, 'Referer': target.origin + '/' } });
  if (!r.ok) return new Response(`Upstream error ${r.status}`, { status: 502, headers: CORS });

  const type = r.headers.get('content-type') || 'video/mp4';
  const ext = (target.pathname.match(VIDEO_EXT)?.[1] || type.split('/')[1]?.split(';')[0] || 'mp4').toLowerCase();
  const safe = safeName(url.searchParams.get('name'));
  const headers = new Headers(CORS);
  headers.set('Content-Type', type.startsWith('video/') ? type : 'video/mp4');
  headers.set('Content-Disposition', `attachment; filename="${safe}.${ext}"`);
  const len = r.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(r.body, { status: 200, headers });
}

export default {
  async fetch(req, env = {}) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/info') return await handleInfo(url, env);
      if (url.pathname === '/dl') return await handleDownload(url, env);
      return new Response('Pluck worker is running.', { headers: CORS });
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      return json({ error: 'Something broke on the server: ' + e.message }, 500);
    }
  },
};
