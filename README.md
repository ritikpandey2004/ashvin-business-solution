# Ashvin Business Solution — Client Intake Backend

Purpose: when someone talks to your AI agent (on the phone or the website
widget), it asks about who they are and what problem they need solved,
then submits a **report** here — not a booking. You review the reports
and decide the solution/next step yourself.

## What it does

- `POST /vapi/webhook` — Vapi sends the `submit_client_report` tool call
  here once the AI has gathered enough info. Saves it to a local SQLite
  database (`reports.db`) and optionally emails you a notification.
- `GET /admin/reports?key=YOUR_ADMIN_KEY` — plain JSON list of every
  report collected, newest first.

Each report has: name, phone, email (optional), service category,
a problem summary in the client's own words, any urgency/deadline
mentioned, and whether it came from a phone call or the website widget.

## 1. Run it locally

```bash
cd intake-backend
npm install
cp .env.example .env
# open .env — set ADMIN_KEY to something private,
# and NOTIFY_EMAIL to the address that should get new-report emails
npm start
```

Test the webhook directly (simulating what Vapi sends):

```bash
curl -X POST http://localhost:3000/vapi/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "toolCallList": [{
        "id": "test-1",
        "function": {
          "name": "submit_client_report",
          "arguments": {
            "name": "Rohit Sharma",
            "phone": "9876543210",
            "service_category": "GST Notice",
            "problem_summary": "Received a GST mismatch notice for FY 2024-25, unsure how to respond.",
            "urgency": "Notice reply due in 6 days",
            "source": "website"
          }
        }
      }]
    }
  }'
```

Then check it landed: `http://localhost:3000/admin/reports?key=YOUR_ADMIN_KEY`

## 2. Deploy it

Same as any small Node app — Render.com or Railway.app both work with a
free tier: connect the folder as a repo, build command `npm install`,
start command `npm start`, and add `ADMIN_KEY` + `NOTIFY_EMAIL` under
Environment Variables.

Note: the free tiers' disks aren't guaranteed to persist forever — fine
while testing, but once this is live for real clients, move `reports.db`
to a small hosted Postgres (Supabase or Neon have free tiers) so reports
are never at risk of disappearing on a redeploy.

## 3. Wire it up in Vapi

In your Vapi assistant's dashboard, under **Tools**:

1. Add a new **Function** tool, paste in `vapi-tool-submit-client-report.json`,
   and replace `https://YOUR-BACKEND-URL` with your real deployed URL
   (e.g. `https://your-app.onrender.com/vapi/webhook`).
2. Attach it to your assistant.
3. In the assistant's **system prompt**, make the goal explicit — something like:

   > You are the intake assistant for Ashvin Business Solution, a GST and
   > income tax filing service. Your job is NOT to solve the caller's tax
   > problem or quote pricing precisely — it's to understand who they are
   > and what they need, so the team can review it and get back to them.
   > Ask for: their name, phone number, what kind of issue it is (GST
   > registration, a notice, ITR filing, TDS, etc.), and a clear
   > description of the problem — encourage them to mention any numbers,
   > dates, or deadlines. Once you have name, phone, and a clear problem
   > description, call submit_client_report. Be warm and reassuring —
   > tax problems make people anxious. Never promise a specific outcome
   > or deadline; just confirm the team will review it and follow up.

## 4. Reviewing reports

Simplest option for now: open `/admin/reports?key=...` whenever you want
to check in, or rely on the email notification if you set `NOTIFY_EMAIL`.
If this grows past a handful of reports a day, say the word and I can
build a proper dashboard page instead of raw JSON.

## Notes

- Vapi requires the webhook to **always return HTTP 200**, even on
  errors — this server does that, putting an `error` field inside the
  JSON result instead so the assistant can recover mid-conversation.
- This replaces the earlier appointment-booking backend — that's not
  what you needed, so it's dropped in favor of this report-based flow.

## Daily articles ("From the desk" section)

`admin.html` is a simple password-protected page for publishing daily
articles — no coding needed day-to-day.

1. Open `admin.html` (host it anywhere, or just open the file locally
   after deploying the backend).
2. At the top of `admin.html`, set `API_BASE` to your deployed backend
   URL — same as the widget.
3. Enter your `ADMIN_KEY`, write the title/excerpt/full article, click
   **Publish Article**.
4. It's saved to the `articles` table and instantly available at
   `GET /articles` — your website's homepage fetches from there
   automatically and renders it as a card in the "From the desk"
   section (see the script at the bottom of the `#articles` section in
   `index.html` — set `ARTICLES_API` there to the same backend URL).

Until you publish your first article, the site still shows the
original "check back soon" placeholder, so there's nothing to break.
