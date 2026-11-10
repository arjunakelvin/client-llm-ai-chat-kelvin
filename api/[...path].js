/**
 * Forwarder untuk API backend PiercingBlow yang hosted di Cloudflare Worker.
 *
 * Vercel hanya boleh menangani dua hal:
 *   - `/api`            → proxy CORS (api/index.js), dipakai web client untuk
 *                         menembak provider OpenAI-compatible dari browser.
 *   - `/api/<apa saja>` → request ini diteruskan ke Worker, yang memegang
 *                         ADMIN_KEY + KV (admin dashboard, login Discord, bot).
 *
 * Tanpa file ini, rewrite `"/api/(.*)"` di vercel.json menelan semua
 * `/api/admin/*` dan dashboard admin hanya bisa menampilkan
 * "Missing target URL in query parameter \"url\"".
 *
 * Set env var WORKER_URL di project Vercel, misal:
 *   WORKER_URL=https://piercingblow-api.<subdomain>.workers.dev
 *
 * Alternatif: pasang route Worker di Cloudflare untuk
 * `piercingblow.ai.id/api*` — kalau route itu aktif, request tidak pernah
 * sampai ke Vercel dan file ini tidak dipakai.
 */

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers',
    'authorization, content-type, accept, x-admin-key, x-secret-key, x-bot-key');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!WORKER_URL) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'WORKER_URL is not set on this Vercel project. Set it to the '
        + 'Cloudflare Worker URL (https://<worker>.<subdomain>.workers.dev) '
        + 'or attach a Worker route for piercingblow.ai.id/api*.',
    }));
    return;
  }

  // `req.query.path` holds the catch-all segments; everything else is a real
  // query parameter that has to reach the Worker untouched.
  const raw = req.query.path;
  const segments = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const query = { ...req.query };
  delete query.path;
  const queryString = Object.entries(query)
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const target =
    `${WORKER_URL}/api/${segments.map(encodeURIComponent).join('/')}`
    + (queryString ? `?${queryString}` : '');

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') {
      continue;
    }
    headers[key] = value;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body && Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (req.body) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') return;
      res.setHeader(key, value);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(payload);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: `Could not reach the Worker at ${WORKER_URL}: ${err.message}`,
    }));
  }
};
