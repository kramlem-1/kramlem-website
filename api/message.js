/*
 * GET /api/message
 *
 * Reads the jarvis@kramlem.com inbox (read-only) and returns today's
 * "TV: <message>" emails from family members. The message is the subject
 * text after "TV:". A message stays up for the Sydney calendar day it was sent.
 *
 * Required env vars (obtain via scripts/get-gmail-token.js):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * Optional:
 *   FAMILY_SENDERS  — comma-separated allowlist (default: the four family addresses)
 *
 * Returns { messages: [{ text, from, at }, ...] } newest first, max 3.
 * Add ?debug=1 to see why emails were included or skipped.
 */

const TZ = 'Australia/Sydney';
const DEFAULT_SENDERS = [
  'mark@kramlem.com',
  'melanie@kramlem.com',
  'harry@kramlem.com',
  'charlize@kramlem.com',
];

const sydDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  return data.access_token;
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function senderAddress(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return res.status(200).json({ messages: [], error: 'Gmail credentials not configured. Run scripts/get-gmail-token.js.' });
  }

  const senders = (process.env.FAMILY_SENDERS
    ? process.env.FAMILY_SENDERS.split(',')
    : DEFAULT_SENDERS).map(s => s.trim().toLowerCase()).filter(Boolean);

  try {
    const token = await getAccessToken();
    const auth  = { Authorization: `Bearer ${token}` };
    const base  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

    const q = `subject:TV newer_than:2d from:(${senders.join(' OR ')})`;
    const listRes = await fetch(`${base}?q=${encodeURIComponent(q)}&maxResults=20`, {
      headers: auth, signal: AbortSignal.timeout(8000),
    });
    const list = await listRes.json();
    if (!listRes.ok) throw new Error(`Gmail list ${listRes.status}: ${list.error?.message || JSON.stringify(list)}`);

    const full = await Promise.all((list.messages || []).map(async ({ id }) => {
      const r = await fetch(
        `${base}/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        { headers: auth, signal: AbortSignal.timeout(8000) }
      );
      return r.ok ? r.json() : null;
    }));

    const today = sydDay(Date.now());
    const debug = [];
    const messages = [];

    for (const msg of full.filter(Boolean)) {
      const subject = header(msg, 'Subject');
      const from    = senderAddress(header(msg, 'From'));
      const sent    = Number(msg.internalDate);
      const match   = subject.match(/^\s*tv:\s*(.+?)\s*$/i);

      let skip = null;
      if (!match)                        skip = 'subject does not start with "TV:"';
      else if (!senders.includes(from))  skip = 'sender not in allowlist';
      else if (sydDay(sent) !== today)   skip = 'not sent today (Sydney)';

      if (req.query.debug === '1') debug.push({ subject, from, sent, skip });
      if (skip) continue;

      const name = from.split('@')[0];
      messages.push({
        text: match[1],
        from: name.charAt(0).toUpperCase() + name.slice(1),
        at:   sent,
      });
    }

    messages.sort((a, b) => b.at - a.at);

    if (req.query.debug === '1') return res.status(200).json({ today, debug, messages });
    res.status(200).json({ messages: messages.slice(0, 3) });
  } catch (err) {
    res.status(200).json({ messages: [], error: err.message });
  }
};
