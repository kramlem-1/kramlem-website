/**
 * Vercel Edge Middleware — Dashboard auth
 *
 * Protects /dashboard and /api/calendar.
 * Unauthenticated requests are redirected to /setup (the login page).
 * /setup and /api/login are intentionally not in the matcher.
 *
 * SETUP
 *   Add DASHBOARD_TOKEN as a Vercel environment variable (any long random string).
 *   Generate one with: openssl rand -base64 32
 *
 *   If DASHBOARD_TOKEN is not set, the dashboard is unprotected (useful locally).
 */

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/api/calendar', '/api/message'],
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k.trim() === name) return v.join('=');
  }
  return null;
}

export default function middleware(request) {
  const token = process.env.DASHBOARD_TOKEN;

  // No token configured → pass through (local dev / not yet set up)
  if (!token) return;

  // Valid cookie → allow
  if (getCookie(request, 'dashboard_auth') === token) return;

  // Not authenticated → redirect to login page
  return Response.redirect(new URL('/setup', request.url), 302);
}
