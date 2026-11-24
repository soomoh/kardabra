import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Installable and offline (the app on my.kardabra.app; not the demo site,
 * which stays a plain page). Links the manifest and emits `sw.js` from
 * `src/pwa/sw.js` with the build's file list and a version hashed from
 * their contents, so any change to any file ships a new worker. Hand-rolled
 * rather than vite-plugin-pwa: Workbox is a large dependency tree for one
 * cache, and a worker short enough to read is part of "verify it yourself".
 */
function pwa(): Plugin {
  let demo = false;
  let publicDir = '';
  return {
    name: 'kardabra-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      demo = config.env.VITE_DEMO === '1';
      publicDir = config.publicDir;
    },
    transformIndexHtml(html) {
      if (demo) return html;
      return html.replace(
        '</title>',
        '</title>\n    <link rel="manifest" href="/manifest.webmanifest" />',
      );
    },
    generateBundle(_, bundle) {
      if (demo) return;
      const files = new Map<string, string | Uint8Array>();
      for (const [name, item] of Object.entries(bundle)) {
        if (name.endsWith('.map')) continue;
        files.set(name, item.type === 'chunk' ? item.code : item.source);
      }
      // Host control files (`_headers`, `_redirects`) and dotfiles are
      // never served: listing one would fail every install (addAll is
      // all-or-nothing).
      const served = (name: string) => !/^[._]/.test(name);
      const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!served(entry.name)) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
          else files.set(prefix + entry.name, readFileSync(path));
        }
      };
      walk(publicDir, '');
      const template = readFileSync(
        new URL('./src/pwa/sw.js', import.meta.url),
        'utf8',
      );
      // The worker's own code counts too: a fix to it alone must not reuse
      // (and overwrite) the cache an open tab is still reading.
      const hash = createHash('sha256').update(template);
      for (const name of [...files.keys()].sort()) {
        hash.update(name).update(files.get(name)!);
      }
      // The app shell is cached as '/' (navigations are answered with it).
      const urls = [...files.keys()]
        .sort()
        .map((name) => (name === 'index.html' ? '/' : encodeURI(`/${name}`)));
      // Replacer functions: a string replacement would read `$&` in a
      // file name as a pattern.
      const source = template
        .replace(
          "'__KARDABRA_VERSION__'",
          () => `'${hash.digest('hex').slice(0, 16)}'`,
        )
        .replace('__KARDABRA_FILES__', () => JSON.stringify(urls));
      if (source.includes('__KARDABRA_')) {
        throw new Error('kardabra-pwa: a placeholder in sw.js was not filled');
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Vite and Vitest share one config. Tests run in Node: the parser is pure, and
// the browser globals it does need (File, TextDecoder) exist in Node, with
// IndexedDB supplied by fake-indexeddb in the db/import tests that import it.
export default defineConfig({
  plugins: [react(), contentSecurityPolicy(), pwa()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
