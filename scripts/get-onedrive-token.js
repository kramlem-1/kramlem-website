#!/usr/bin/env node
/**
 * One-time script to get a OneDrive refresh token for the family dashboard.
 *
 * SETUP (do this once):
 *
 * 1. Go to https://portal.azure.com
 *    → Microsoft Entra ID → App registrations → New registration
 *    - Name: "Family Dashboard" (anything)
 *    - Supported account types: "Personal Microsoft accounts only"
 *    - Redirect URI: choose "Mobile and desktop applications"
 *      enter:  http://localhost:8080/callback
 *    → Register
 *
 * 2. On the app overview page, copy the "Application (client) ID"
 *
 * 3. Go to Certificates & secrets → New client secret
 *    - Description: anything, Expires: 24 months
 *    → Add, then immediately copy the VALUE (not the ID)
 *
 * 4. Go to API permissions → Add a permission → Microsoft Graph
 *    → Delegated permissions → search "Files.Read" → add it
 *    (offline_access is already there by default)
 *    → Grant admin consent is NOT needed for personal accounts
 *
 * 5. Run this script:
 *    ONEDRIVE_CLIENT_ID=<paste> ONEDRIVE_CLIENT_SECRET=<paste> node scripts/get-onedrive-token.js
 *
 * 6. Open the printed URL in your browser, sign in, approve.
 *    The script captures the callback and prints your ONEDRIVE_REFRESH_TOKEN.
 *
 * 7. Add to Vercel environment variables:
 *    ONEDRIVE_CLIENT_ID
 *    ONEDRIVE_CLIENT_SECRET
 *    ONEDRIVE_REFRESH_TOKEN
 *    ONEDRIVE_FOLDER=Family Dashboard Photos
 */

const http = require('http');

const CLIENT_ID     = process.env.ONEDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.ONEDRIVE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:8080/callback';
const SCOPES        = 'Files.Read offline_access';
const TENANT        = 'consumers';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set ONEDRIVE_CLIENT_ID and ONEDRIVE_CLIENT_SECRET before running.');
  console.error('Example:');
  console.error('  ONEDRIVE_CLIENT_ID=xxx ONEDRIVE_CLIENT_SECRET=yyy node scripts/get-onedrive-token.js');
  process.exit(1);
}

const authUrl =
  `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&response_mode=query`;

console.log('\n=== OneDrive OAuth Token Helper ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nSign in and approve — this script will capture the result automatically.\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.end('Waiting...');
    return;
  }

  const url  = new URL(req.url, 'http://localhost:8080');
  const code = url.searchParams.get('code');
  const err  = url.searchParams.get('error');

  if (err) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error: ${err}</h1><p>${url.searchParams.get('error_description') || ''}</p>`);
    console.error('\nAuth failed:', err, url.searchParams.get('error_description'));
    server.close();
    return;
  }

  if (!code) {
    res.end('No code. Try again.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Done! Check your terminal for the refresh token.</h1>');
  server.close();

  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
    scope:         SCOPES,
  });

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      }
    );

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('\nToken exchange failed:', tokens.error_description || tokens.error);
      process.exit(1);
    }

    console.log('\n=== SUCCESS — add these to Vercel environment variables ===\n');
    console.log(`ONEDRIVE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`ONEDRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`ONEDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`ONEDRIVE_FOLDER=Family Dashboard Photos`);
    console.log('\nDone!\n');
  } catch (e) {
    console.error('\nFailed to exchange token:', e.message);
    process.exit(1);
  }
});

server.listen(8080, () => {
  console.log('Listening on http://localhost:8080/callback ...\n');
});
