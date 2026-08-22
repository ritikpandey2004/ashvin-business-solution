console.log('Server script starting...');
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
console.log('Modules loaded OK.');

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
// Tiny JSON-file "database" — no native dependencies, so it runs
// anywhere (Render, Railway, etc.) without native-module build
// issues. Fine for a small business's volume of data.
// ---------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadTable(name) {
  const file = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${name}.json:`, err.message);
    return [];
  }
}

function saveTable(name, rows) {
  const file = path.join(DATA_DIR, name + '.json');
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

function nextId(rows) {
  return rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;
}

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

  const reports = loadTable('reports');
  reports.push({
    id: nextId(reports),
    name,
    phone,
    email: email || null,
    service_category: service_category || 'Not specified',
    problem_summary,
    urgency: urgency || 'Not specified',
    source: source || 'unknown',
    created_at: new Date().toISOString(),
  });
  saveTable('reports', reports);

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
  const reports = loadTable('reports').sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(reports);
});

// ---------------------------------------------------------------
// Articles — daily blog posts shown on the website's "From the desk"
// section.
// ---------------------------------------------------------------

// PUBLIC — the website fetches this on page load to render article cards.
app.get('/articles', (req, res) => {
  const articles = loadTable('articles')
    .map(({ id, title, excerpt, published_date }) => ({ id, title, excerpt, published_date }))
    .sort((a, b) => b.published_date.localeCompare(a.published_date) || b.id - a.id);
  res.json(articles);
});

// PUBLIC — full text of one article (for a future article detail page).
app.get('/articles/:id', (req, res) => {
  const articles = loadTable('articles');
  const row = articles.find((a) => String(a.id) === req.params.id);
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

  const articles = loadTable('articles');
  const id = nextId(articles);
  articles.push({
    id,
    title,
    excerpt,
    body,
    published_date: published_date || new Date().toISOString().slice(0, 10),
  });
  saveTable('articles', articles);

  res.json({ confirmed: true, id });
});

// ADMIN — delete an article, in case you want to take one down.
app.post('/admin/articles/delete', (req, res) => {
  const { key, id } = req.body || {};
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const articles = loadTable('articles').filter((a) => String(a.id) !== String(id));
  saveTable('articles', articles);
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

  const visits = loadTable('visits');
  visits.push({
    id: nextId(visits),
    ip,
    page: page || '/',
    referrer: referrer || '',
    user_agent: userAgent,
    created_at: new Date().toISOString(),
  });
  saveTable('visits', visits);

  res.status(200).json({ ok: true });
});

// ADMIN — total visit count + unique visitor (by IP) count.
app.get('/admin/visits/summary', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const visits = loadTable('visits');
  const totalVisits = visits.length;
  const uniqueVisitors = new Set(visits.map((v) => v.ip)).size;
  const today = new Date().toISOString().slice(0, 10);
  const visitsToday = visits.filter((v) => v.created_at.slice(0, 10) === today).length;

  res.json({ totalVisits, uniqueVisitors, visitsToday });
});

// ADMIN — raw visit log, newest first (capped at 500 for safety).
app.get('/admin/visits', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const visits = loadTable('visits')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 500);
  res.json(visits);
});

app.get('/', (req, res) => {
  res.send('Ashvin Business Solution — client intake backend is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Intake backend listening on port ${PORT}`));
