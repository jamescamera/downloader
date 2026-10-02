// Pluck — Cloudflare Worker
// Paste this whole file into a Cloudflare Worker and deploy.
// Endpoints:
//   GET /info?url=<tweet link>        -> JSON list of video files
//   GET /dl?u=<video.twimg.com url>&name=<filename>  -> streams the mp4 as a download

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function tweetIdFrom(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/status(?:es)?\/(\d{5,25})/);
  if (m) return m[1];
  if (/^\d{5,25}$/.test(s)) return s;
  return null;
}

// Same token the official embed widget uses
function tokenFor(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function collectVideos(tweet) {
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
          };
        })
        .sort((a, b) => b.bitrate - a.bitrate);
      if (variants.length) {
        out.push({
          type: m.type === 'animated_gif' ? 'gif' : 'video',
          thumb: m.media_url_https,
          durationMs: m.video_info?.duration_millis || null,
          fromQuote: t !== tweet,
          variants,
        });
      }
    }
  }
  return out;
}

async function handleInfo(url) {
  const id = tweetIdFrom(url.searchParams.get('url'));
  if (!id) return json({ error: 'That doesn’t look like a post link. Paste a link containing /status/ followed by numbers.' }, 400);

  const api = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${tokenFor(id)}`;
  const r = await fetch(api, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pluck/1.0)' },
    cf: { cacheTtl: 300 },
  });

  if (!r.ok) {
    return json({ error: `X didn’t return this post (status ${r.status}). It may be deleted, private, or marked sensitive.` }, 502);
  }

  const text = await r.text();
  if (!text) return json({ error: 'X returned nothing for this post. It may be private, deleted, or age-restricted.' }, 404);

  let tweet;
  try { tweet = JSON.parse(text); } catch { return json({ error: 'X returned something unreadable. Try again in a minute.' }, 502); }

  if (tweet.__typename === 'TweetTombstone') {
    return json({ error: 'This post is unavailable — usually deleted, protected, or age-restricted.' }, 404);
  }

  const videos = collectVideos(tweet);
  if (!videos.length) return json({ error: 'No video or GIF found in this post.' }, 404);

  return json({
    id,
    user: tweet.user?.screen_name || 'x',
    name: tweet.user?.name || '',
    text: tweet.text || '',
    videos,
  });
}

async function handleDownload(url) {
  let target;
  try { target = new URL(url.searchParams.get('u')); } catch { return new Response('Bad url', { status: 400, headers: CORS }); }
  // Only allow X's video CDN so this can't be used as an open proxy
  if (target.protocol !== 'https:' || target.hostname !== 'video.twimg.com') {
    return new Response('Only video.twimg.com links are allowed', { status: 403, headers: CORS });
  }

  const r = await fetch(target.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return new Response(`Upstream error ${r.status}`, { status: 502, headers: CORS });

  const safe = (url.searchParams.get('name') || 'video').replace(/[^\w.-]/g, '_').slice(0, 80);
  const headers = new Headers(CORS);
  headers.set('Content-Type', 'video/mp4');
  headers.set('Content-Disposition', `attachment; filename="${safe}.mp4"`);
  const len = r.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(r.body, { status: 200, headers });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/info') return await handleInfo(url);
      if (url.pathname === '/dl') return await handleDownload(url);
      return new Response('Pluck worker is running.', { headers: CORS });
    } catch (e) {
      return json({ error: 'Something broke on the server: ' + e.message }, 500);
    }
  },
};
