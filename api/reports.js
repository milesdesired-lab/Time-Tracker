// api/reports.js — list archived monthly CSVs from a PRIVATE Supabase Storage
// bucket and hand back short-lived signed URLs.
//
// The `reports` bucket should be set to Private in the Supabase dashboard.
// Because signing uses the service key server-side, the browser can still
// download archives without the bucket (or the key) being public.

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET   = process.env.APP_SECRET;
const BUCKET       = 'reports';
const SIGN_TTL     = 60 * 60; // 1 hour

function authorized(req) {
  if (!APP_SECRET) return false;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(APP_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function storage(path, body) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const files = await storage(`object/list/${BUCKET}`, {
      prefix: '', limit: 100, offset: 0, sortBy: { column: 'name', order: 'desc' }
    });
    const csvFiles = (files || []).filter(f => f.name && f.name.endsWith('.csv'));

    const out = [];
    for (const f of csvFiles) {
      let url = null;
      try {
        const signed = await storage(`object/sign/${BUCKET}/${encodeURIComponent(f.name)}`, { expiresIn: SIGN_TTL });
        // Supabase returns e.g. { signedURL: "/object/sign/reports/x.csv?token=..." }
        const rel = signed.signedURL || signed.signedUrl || '';
        if (rel) url = `${SUPABASE_URL}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
      } catch (e) {
        console.error('sign failed for', f.name, e.message);
      }
      out.push({
        name: f.name,
        size: (f.metadata && f.metadata.size) || null,
        url
      });
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error('reports handler error:', err && err.stack || err);
    return res.status(500).json({ error: 'Server error' });
  }
}
