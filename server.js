require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// Allow the website and admin page (hosted elsewhere) to call this API
// from the browser.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------
const db = new Database(path.join(__dirname, 'reports.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    service_category TEXT,
    problem_summary TEXT NOT NULL,
    urgency TEXT,
    source TEXT,              -- 'phone' or 'website'
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    body TEXT NOT NULL,
    published_date TEXT NOT NULL,   -- YYYY-MM-DD, shown on the site
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    page TEXT,
    referrer TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ---------------------------------------------------------------
// Tool implementation: submit_client_report
// Called by the AI agent once it has gathered enough info about
// who the caller is and what problem they need solved.
// ---------------------------------------------------------------
function submitClientReport(args) {
  const { name, phone, email, service_category, problem_summary, urgency, source } = args;

  if (!name || !phone || !problem_summary) {
    return {
      error: 'Missing required info: name, phone, and problem_summary are all required before submitting.',
    };
  }

  db.prepare(
    `INSERT INTO reports (name, phone, email, service_category, problem_summary, urgency, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    phone,
    email || null,
    service_category || 'Not specified',
    problem_summary,
    urgency || 'Not specified',
    source || 'unknown'
  );

  // Fire-and-forget email notification so you see new reports immediately.
  // Uses the same FormSubmit.co endpoint your website contact form already uses.
  if (process.env.NOTIFY_EMAIL) {
    fetch('https://formsubmit.co/ajax/' + process.env.NOTIFY_EMAIL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Name: name,
        Phone: phone,
        Email: email || '-',
        'Service Category': service_category || 'Not specified',
        Urgency: urgency || 'Not specified',
        'Problem Summary': problem_summary,
        Source: source || 'unknown',
        _subject: 'New AI call agent report — ' + name,
      }),
    }).catch((err) => console.error('Email notify failed:', err.message));
  }

  return {
    confirmed: true,
    message: `Thanks ${name}, we've noted your details and our team will review your case and get back to you shortly.`,
  };
}

// ---------------------------------------------------------------
// Vapi webhook
// Vapi POSTs tool calls here as: { message: { toolCallList: [...] } }
// We must always respond 200 with: { results: [{ toolCallId, result }] }
// (result must be a string, per Vapi's custom tools docs)
// ---------------------------------------------------------------
app.post('/vapi/webhook', (req, res) => {
  try {
    const toolCalls = req.body?.message?.toolCallList || [];

    const results = toolCalls.map((call) => {
      const fnName = call.function?.name;
      const args = call.function?.arguments || {};

      let output;
      if (fnName === 'submit_client_report') {
        output = submitClientReport(args);
      } else {
        output = { error: `Unknown tool: ${fnName}` };
      }

      return { toolCallId: call.id, result: JSON.stringify(output) };
    });

    res.status(200).json({ results });
  } catch (err) {
    console.error('Webhook error:', err);
    // Always return 200 — a non-200 response is ignored entirely by Vapi
    res.status(200).json({ results: [] });
  }
});

// ---------------------------------------------------------------
// Simple admin view — see every report the AI agent has collected
// GET /admin/reports?key=YOUR_ADMIN_KEY
// ---------------------------------------------------------------
app.get('/admin/reports', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(rows);
});

// ---------------------------------------------------------------
// Articles — daily blog posts shown on the website's "From the desk"
// section.
// ---------------------------------------------------------------

// PUBLIC — the website fetches this on page load to render article cards.
app.get('/articles', (req, res) => {
  const rows = db
    .prepare('SELECT id, title, excerpt, published_date FROM articles ORDER BY published_date DESC, id DESC')
    .all();
  res.json(rows);
});

// PUBLIC — full text of one article (for a future article detail page).
app.get('/articles/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ADMIN — add a new article. Protected by ADMIN_KEY (sent in request body).
app.post('/admin/articles', (req, res) => {
  const { key, title, excerpt, body, published_date } = req.body || {};
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!title || !excerpt || !body) {
    return res.status(400).json({ error: 'title, excerpt, and body are all required.' });
  }

  const date = published_date || new Date().toISOString().slice(0, 10);
  const result = db
    .prepare('INSERT INTO articles (title, excerpt, body, published_date) VALUES (?, ?, ?, ?)')
    .run(title, excerpt, body, date);

  res.json({ confirmed: true, id: result.lastInsertRowid });
});

// ADMIN — delete an article, in case you want to take one down.
app.post('/admin/articles/delete', (req, res) => {
  const { key, id } = req.body || {};
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!id) return res.status(400).json({ error: 'id is required.' });

  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  res.json({ confirmed: true });
});

// ---------------------------------------------------------------
// Visitor tracking
// ---------------------------------------------------------------

// PUBLIC — the website calls this once per page load to log a visit.
app.post('/track-visit', (req, res) => {
  const { page, referrer } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || '';

  db.prepare(
    'INSERT INTO visits (ip, page, referrer, user_agent) VALUES (?, ?, ?, ?)'
  ).run(ip, page || '/', referrer || '', userAgent);

  res.status(200).json({ ok: true });
});

// ADMIN — total visit count + unique visitor (by IP) count.
app.get('/admin/visits/summary', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const totalVisits = db.prepare('SELECT COUNT(*) AS n FROM visits').get().n;
  const uniqueVisitors = db.prepare('SELECT COUNT(DISTINCT ip) AS n FROM visits').get().n;
  const today = new Date().toISOString().slice(0, 10);
  const visitsToday = db
    .prepare("SELECT COUNT(*) AS n FROM visits WHERE date(created_at) = date(?)")
    .get(today).n;

  res.json({ totalVisits, uniqueVisitors, visitsToday });
});

// ADMIN — raw visit log, newest first (capped at 500 for safety).
app.get('/admin/visits', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const rows = db
    .prepare('SELECT * FROM visits ORDER BY created_at DESC LIMIT 500')
    .all();
  res.json(rows);
});

app.get('/', (req, res) => {
  res.send('Ashvin Business Solution — client intake backend is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Intake backend listening on port ${PORT}`));
