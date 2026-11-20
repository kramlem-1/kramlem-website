#!/usr/bin/env node
/**
 * One-time script to get a read-only Gmail refresh token for jarvis@kramlem.com,
 * used by /api/message to show "TV: ..." emails on the dashboard.
 *
 * Reuses the Google OAuth client already in ~/.credentials/google-calendar-credentials.json.
 *
 * Run:   node scripts/get-gmail-token.js
 * Then open the printed URL, sign in as jarvis@kramlem.com, and approve.
 * Add the three printed values to Vercel as environment variables and redeploy.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const CREDENTIALS_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.credentials', 'google-calendar-credentials.json');
const PORT  = 8085;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const { client_id, client_secret } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).installed;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id, redirect_uri: REDIRECT, response_type: 'code',
  scope: SCOPE, access_type: 'offline', prompt: 'consent',
  login_hint: 'jarvis@kramlem.com',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

  const code = url.searchParams.get('code');
  if (!code) { res.end('No code received.'); return; }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id, client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await r.json();

  if (!data.refresh_token) {
    res.end('Failed — see terminal.');
    console.error('No refresh token returned:', data);
    server.close();
    return;
  }

  res.end('Done — you can close this tab and return to the terminal.');
  console.log('\nAdd these to Vercel (Settings > Environment Variables):\n');
  console.log(`GMAIL_CLIENT_ID=${client_id}`);
  console.log(`GMAIL_CLIENT_SECRET=${client_secret}`);
  console.log(`GMAIL_REFRESH_TOKEN=${data.refresh_token}\n`);
  server.close();
});

server.listen(PORT, () => {
  console.log('Open this URL and sign in as jarvis@kramlem.com:\n');
  console.log(authUrl.toString() + '\n');
});
