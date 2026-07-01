// api/tasks.js — authenticated CRUD proxy to Supabase.
//
// The browser never sees the Supabase service key. It authenticates to THIS
// endpoint with a bearer token (APP_SECRET); the server then talks to Supabase
// using the service_role key, which bypasses RLS. This keeps the database
// locked to anon access (see supabase.sql) while the app keeps working.
//
// Columns: id, text, urgent, deadline_type, deadline_date, deadline_time, done, reminder_sent, created_at

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET   = process.env.APP_SECRET;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE  = /^\d{2}:\d{2}(:\d{2})?$/;

// ── Supabase REST helper (service key — bypasses RLS)
async function db(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'GET' ? '' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return null; }
}

// ── Constant-time bearer check; fails closed if APP_SECRET is unset
function authorized(req) {
  if (!APP_SECRET) return false;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(APP_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Whitelist + validate writable fields; throws on bad input
function cleanTaskInput(body, { partial } = { partial: false }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('text')) {
    if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('invalid text');
    out.text = body.text.trim().slice(0, 2000);
  } else if (!partial) {
    throw new Error('text is required');
  }

  if (has('urgent'))        out.urgent = !!body.urgent;
  if (has('done'))          out.done = !!body.done;
  if (has('reminder_sent')) out.reminder_sent = !!body.reminder_sent;

  if (has('deadline_type')) {
    if (!['today', 'date'].includes(body.deadline_type)) throw new Error('invalid deadline_type');
    out.deadline_type = body.deadline_type;
  }
  if (has('deadline_date')) {
    if (!DATE_RE.test(body.deadline_date)) throw new Error('invalid deadline_date');
    out.deadline_date = body.deadline_date;
  }
  if (has('deadline_time')) {
    if (body.deadline_time === null) out.deadline_time = null;
    else if (TIME_RE.test(body.deadline_time)) out.deadline_time = body.deadline_time;
    else throw new Error('invalid deadline_time');
  }

  if (!partial && !out.deadline_type) out.deadline_type = 'today';
  return out;
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = (req.query && req.query.id) || '';
  if (id && !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    switch (req.method) {
      case 'GET': {
        const month = (req.query && req.query.month) || '';
        if (month) {
          if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Invalid month' });
          const [y, m] = month.split('-').map(Number);
          const start = `${y}-${String(m).padStart(2, '0')}-01`;
          const ny = m === 12 ? y + 1 : y;
          const nm = m === 12 ? 1 : m + 1;
          const end = `${ny}-${String(nm).padStart(2, '0')}-01`;
          const rows = await db('GET',
            `tasks?deadline_date=gte.${start}&deadline_date=lt.${end}&order=deadline_date.asc,created_at.asc`);
          return res.status(200).json(rows || []);
        }
        const rows = await db('GET', 'tasks?order=deadline_date.asc,created_at.desc');
        return res.status(200).json(rows || []);
      }

      case 'POST': {
        const payload = cleanTaskInput(req.body || {}, { partial: false });
        if (!('done' in payload)) payload.done = false;
        if (!('reminder_sent' in payload)) payload.reminder_sent = false;
        const [row] = await db('POST', 'tasks', payload);
        return res.status(201).json(row);
      }

      case 'PATCH': {
        if (!id) return res.status(400).json({ error: 'id required' });
        const payload = cleanTaskInput(req.body || {}, { partial: true });
        if (!Object.keys(payload).length) return res.status(400).json({ error: 'no fields to update' });
        const rows = await db('PATCH', `tasks?id=eq.${id}`, payload);
        if (!rows || !rows.length) return res.status(404).json({ error: 'not found' });
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        if (!id) return res.status(400).json({ error: 'id required' });
        await db('DELETE', `tasks?id=eq.${id}`);
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    // Client input errors vs server/db errors
    const isInput = /^invalid |is required|no fields/i.test(err.message || '');
    if (isInput) return res.status(400).json({ error: err.message });
    console.error('tasks handler error:', err && err.stack || err);
    return res.status(500).json({ error: 'Server error' });
  }
}
