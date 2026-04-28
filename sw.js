/**
 * Cine Party Service Worker
 * Intercepts requests to /__dav__/* and forwards them to the real WebDAV
 * server with Authorization headers.
 */

let credentials = null;
let credentialsResolvers = []; // Pending fetch handlers waiting for creds

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'set-credentials') {
    credentials = event.data.credentials;
    console.log('[SW] Credentials received');
    // Resolve any pending fetches
    const resolvers = credentialsResolvers;
    credentialsResolvers = [];
    for (const r of resolvers) r();
    if (event.source) {
      event.source.postMessage({ type: 'credentials-set' });
    }
  } else if (event.data && event.data.type === 'clear-credentials') {
    credentials = null;
  } else if (event.data && event.data.type === 'ping') {
    if (event.source) {
      event.source.postMessage({ type: 'pong' });
    }
  }
});

// Wait up to 5 seconds for credentials to arrive
function waitForCredentials() {
  if (credentials) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Remove ourselves from resolvers list
      const idx = credentialsResolvers.indexOf(resolve);
      if (idx >= 0) credentialsResolvers.splice(idx, 1);
      resolve();
    }, 5000);
    credentialsResolvers.push(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/__dav__/')) return;
  event.respondWith(handleDavFetch(event.request, url));
});

async function handleDavFetch(request, url) {
  // Wait briefly for credentials if not set yet
  if (!credentials) {
    await waitForCredentials();
  }
  if (!credentials) {
    return new Response('SW: credentials timeout', { status: 503 });
  }

  // Strip prefix and decode each segment, then re-encode safely for outgoing URL
  const rawPath = url.pathname.replace(/^\/__dav__/, '');
  const decodedSegments = rawPath.split('/').map(seg => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  });
  const safeOutgoingPath = decodedSegments
    .map(seg => seg ? encodeURIComponent(seg) : '')
    .join('/');

  const targetUrl = credentials.origin + safeOutgoingPath + url.search;
  // Don't log the target URL on every range request — DevTools console is
  // visible to anyone on the device, and a movie generates thousands of
  // chunks. SETUP.md §7 promises a low-trace UX; honour it.

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization' || lowerKey === 'host' || lowerKey === 'origin') continue;
    headers.set(key, value);
  }
  headers.set('Authorization', 'Basic ' + btoa(credentials.user + ':' + credentials.pass));

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });

    const newHeaders = new Headers(response.headers);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    console.warn('[SW] fetch error:', err.message);
    // Don't echo err.message into the response body — upstream errors can
    // contain URLs or other detail readable by the page.
    return new Response('SW: upstream error', { status: 502 });
  }
}

