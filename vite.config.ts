import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Content Security Policy, as a meta tag in the built index.html (GitHub
 * Pages can't send headers). `connect-src 'none'` is the no-network promise
 * enforced by the browser. Build only: the dev server needs a websocket and
 * inline scripts for hot reload. Inline scripts (the pre-paint theme script)
 * are allowed by hash, computed here so editing one can't silently break it.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'kardabra-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Every inline script (any <script> without src) is hashed, so a
        // new one can't be silently blocked.
        const hashes = [
          ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
        ]
          .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs))
          .map(
            ([, , body]) =>
              `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
          );
        const policy = [
          "default-src 'none'",
          `script-src 'self' ${hashes.join(' ')}`,
          "style-src 'self'",
          "font-src 'self'",
          "img-src 'self'",
          "worker-src 'self'", // pdf.js worker, bundled
          "manifest-src 'self'",
          "connect-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
        ].join('; ');
        // Right after the charset (which must stay in the first 1024
        // bytes) and before any script the policy has to cover.
        const charset = '<meta charset="UTF-8" />';
        if (!html.includes(charset)) {
          throw new Error(`kardabra-csp: ${charset} not found in index.html`);
        }
        const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
        return html.replace(charset, `${charset}\n    ${meta}`);
      },
    },
  };
}

// Vite and Vitest share one config. Tests run in Node: the parser is pure, and
// the browser globals it does need (File, TextDecoder) exist in Node, with
// IndexedDB supplied by fake-indexeddb in the db/import tests that import it.
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
