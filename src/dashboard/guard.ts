import type * as http from 'node:http';

/**
 * Only this page may drive the dashboard. Binding to 127.0.0.1 is not enough:
 * any site open in the same browser can POST to localhost (a text/plain body
 * skips the CORS preflight), and DNS rebinding can read it. So: the Host must
 * be this server, and a POST must come from this origin, as JSON, with a
 * custom header, which forces a preflight this server never approves. API
 * reads need the header too: each costs authenticated Alpaca calls, and an
 * <img> on any site could otherwise spend the key's rate limit.
 */
export function requestAllowed(method: string, headers: http.IncomingHttpHeaders, port: number, pathname = '/'): boolean {
  const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!own.has(String(headers.host ?? ''))) return false;
  if (method === 'GET') return !pathname.startsWith('/api/') || headers['x-dashboard'] === '1';
  const origin = headers.origin;
  if (origin !== undefined && !own.has(String(origin).replace(/^http:\/\//, ''))) return false;
  return headers['x-dashboard'] === '1' && String(headers['content-type'] ?? '').startsWith('application/json');
}
