import { error, type Handle } from '@sveltejs/kit';
export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith('/api/')) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(event.url.hostname)) error(403, 'Player Two only accepts local requests.');
    const origin = event.request.headers.get('origin');
    if (origin && origin !== event.url.origin) error(403, 'Cross-origin requests are not accepted.');
    if (event.request.headers.get('sec-fetch-site') === 'cross-site') error(403, 'Cross-site requests are not accepted.');
    if (event.request.method === 'POST' && !event.request.headers.get('content-type')?.startsWith('application/json')) error(415, 'Expected JSON.');
  }
  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
};
