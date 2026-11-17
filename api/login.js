/*
 * POST /api/login
 *
 * Verifies the submitted password against DASHBOARD_TOKEN.
 * On success: sets the auth cookie and redirects to /dashboard.
 * On failure: redirects back to /setup?error=1.
 */

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const token = process.env.DASHBOARD_TOKEN;

  // No token configured → just go to the dashboard
  if (!token) {
    return res.redirect(302, '/dashboard');
  }

  // Vercel parses application/x-www-form-urlencoded into req.body automatically
  let submitted = '';
  if (req.body && typeof req.body === 'object') {
    submitted = req.body.password || '';
  } else if (typeof req.body === 'string') {
    submitted = new URLSearchParams(req.body).get('password') || '';
  }

  if (submitted !== token) {
    return res.redirect(302, '/setup?error=1');
  }

  res.setHeader('Set-Cookie', [
    `dashboard_auth=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000', // 1 year
  ].join('; '));

  return res.redirect(302, '/dashboard');
};
