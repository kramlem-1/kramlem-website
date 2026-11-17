/**
 * Vercel Edge Middleware — Dashboard auth
 *
 * Protects /dashboard and /api/calendar with a token-based cookie.
 *
 * HOW IT WORKS
 *   1. Visit /dashboard?token=YOUR_TOKEN on any device (TV, phone, laptop).
 *      The middleware sets a 1-year cookie and redirects to /dashboard.
 *   2. All subsequent visits to /dashboard use the cookie — no token needed.
 *
 * SETUP
 *   Add DASHBOARD_TOKEN as a Vercel environment variable (any long random string).
 *   Generate one with: openssl rand -base64 32
 *
 *   If DASHBOARD_TOKEN is not set, the dashboard is unprotected (useful locally).
 */

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/api/calendar'],
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export default function middleware(request) {
  const token = process.env.DASHBOARD_TOKEN;

  // No token configured → pass through (local dev / not yet set up)
  if (!token) return;

  const url = new URL(request.url);

  // ── 1. Valid cookie → allow ──────────────────────────────────────────
  if (getCookie(request, 'dashboard_auth') === token) return;

  // ── 2. Correct ?token= → set cookie, redirect to clean URL ──────────
  if (url.searchParams.get('token') === token) {
    url.searchParams.delete('token');
    return new Response(null, {
      status: 302,
      headers: {
        'Location': url.pathname + (url.search || ''),
        'Set-Cookie': [
          `dashboard_auth=${token}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          'Max-Age=31536000', // 1 year — stays logged in on the TV
        ].join('; '),
        'Cache-Control': 'no-store',
      },
    });
  }

  // ── 3. No valid token → 401 ──────────────────────────────────────────
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kramlem Dashboard</title>
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center;
           height: 100vh; background: #090910; color: #5a5a88;
           font-family: system-ui, sans-serif; }
    p { font-size: 1.1rem; line-height: 1.7; text-align: center; }
    code { color: #7c9eff; }
  </style>
</head>
<body>
  <p>Add <code>?token=…</code> to the URL to access this dashboard.</p>
</body>
</html>`,
    { status: 401, headers: { 'Content-Type': 'text/html' } }
  );
}
