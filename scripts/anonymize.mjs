#!/usr/bin/env node
// Turn real statements into synthetic ones you can share.
//
//   npm run anonymize -- inbox/real/*
//
// Output goes to inbox/synthetic/ (gitignored) under a neutral name, with a
// .report.txt beside it listing what was kept verbatim — read it before
// sharing. For password-protected PDFs you are asked ONCE for your name, date
// of birth and cards' last four digits; each bank's password patterns are
// tried from those. Only if none opens a file are you asked for that file's
// password (Enter skips it). Nothing you type is stored, written out, or sent
// anywhere; it lives only for this run. Nothing here uses the network.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'inbox', 'synthetic');

// --- prompts: hidden input on a terminal; plain lines when piped (tests) ---

let pipedLines;
async function nextPipedLine() {
  pipedLines ??= createInterface({ input: process.stdin })[
    Symbol.asyncIterator
  ]();
  const { value, done } = await pipedLines.next();
  return done ? '' : value;
}

function ask(prompt, { hidden = false } = {}) {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  if (!stdin.isTTY) {
    return nextPipedLine().then((line) => {
      stdout.write('\n');
      return line.trim();
    });
  }
  if (!hidden) {
    const rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: false,
    });
    return new Promise((done) =>
      rl.once('line', (line) => {
        rl.close();
        done(line.trim());
      }),
    );
  }
  return new Promise((done) => {
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          done(value);
          return;
        }
        if (ch === '\u0003') process.exit(130); // Ctrl-C
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------

async function main() {
  // `npm run` executes from the project root, but the shell expanded the
  // paths relative to where the user typed the command — npm passes that
  // folder as INIT_CWD, so resolve against it.
  const invokedFrom = process.env.INIT_CWD ?? process.cwd();
  const files = process.argv.slice(2).map((p) => resolve(invokedFrom, p));
  if (files.length === 0) {
    console.error(
      'usage: npm run anonymize -- <statement files…>  (e.g. inbox/real/*)',
    );
    process.exit(2);
  }

  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  });
  const done = [];
  const skipped = [];
  try {
    const { anonymizeFile, PdfPasswordError } = await server.ssrLoadModule(
      '/src/anonymize/index.ts',
    );
    const { passwordCandidates, parseDob } = await server.ssrLoadModule(
      '/src/lib/pdfPassword.ts',
    );
    const { bankFromFileName } = await server.ssrLoadModule(
      '/src/lib/bankDetect.ts',
    );
    mkdirSync(outDir, { recursive: true });

    const write = (path, result, note = '') => {
      writeFileSync(join(outDir, result.fileName), result.data);
      writeFileSync(
        join(outDir, result.fileName + '.report.txt'),
        result.report,
      );
      // The original name is printed to your terminal only — never written
      // into the output, which may be shared.
      console.log(
        `✓ ${basename(path)} → inbox/synthetic/${result.fileName}${note}`,
      );
      done.push(path);
    };

    // Pass 1: everything that opens without a password.
    const locked = [];
    for (const path of files) {
      try {
        write(path, await anonymizeFile(new Uint8Array(readFileSync(path))));
      } catch (error) {
        if (error instanceof PdfPasswordError) locked.push(path);
        else if (error && error.code === 'ENOENT')
          skipped.push([path, 'file not found']);
        else
          skipped.push([
            path,
            error instanceof Error ? error.message : String(error),
          ]);
      }
    }

    // Pass 2: locked PDFs — ask once, try every bank's patterns.
    if (locked.length > 0) {
      console.log(
        `\n${locked.length} PDF(s) are password-protected. Answer once; nothing is saved.`,
      );
      const name = await ask('Name as printed on your cards: ');
      let dob = null;
      for (let i = 0; i < 3 && dob === null; i++) {
        dob = parseDob(
          await ask('Date of birth (DD/MM/YYYY, hidden): ', { hidden: true }),
        );
        if (dob === null)
          console.log('  Please use DD/MM/YYYY, e.g. 07/03/1990.');
      }
      const last4s = (
        await ask(
          "Cards' last 4 digits, comma-separated (optional; SBI needs them): ",
        )
      )
        .split(/[,\s]+/)
        .filter((s) => /^\d{4}$/.test(s));

      for (const path of locked) {
        const bytes = new Uint8Array(readFileSync(path));
        const bank = bankFromFileName(basename(path));
        const candidates = dob
          ? passwordCandidates({ name, dob, last4s }, bank)
          : [];
        try {
          const result = await anonymizeFile(bytes, {
            passwords: candidates.map((c) => c.password),
          });
          const pattern = candidates[result.unlockedWith]?.pattern;
          write(
            path,
            result,
            `  (opened with pattern ${pattern}; bank guess: ${bank ?? 'unknown'})`,
          );
          continue;
        } catch (error) {
          if (!(error instanceof PdfPasswordError)) {
            skipped.push([
              path,
              error instanceof Error ? error.message : String(error),
            ]);
            continue;
          }
        }
        console.log(
          `  ${basename(path)}: none of the ${candidates.length} patterns opened it.`,
        );
        // A card's last 4 is the usual missing piece (SBI's password is DOB +
        // last 4), so accept that here as well as the password itself.
        const typed = await ask(
          "  Its password, or that card's last 4 digits (Enter to skip, hidden): ",
          { hidden: true },
        );
        if (typed === '') {
          skipped.push([
            path,
            'skipped — no pattern matched and nothing entered',
          ]);
          continue;
        }
        const retry =
          /^\d{4}$/.test(typed) && dob
            ? passwordCandidates(
                { name, dob, last4s: [...last4s, typed] },
                bank,
              )
            : [];
        try {
          const result = await anonymizeFile(bytes, {
            passwords: [typed, ...retry.map((c) => c.password)],
          });
          const how =
            result.unlockedWith === 0
              ? 'the password you typed'
              : `pattern ${retry[result.unlockedWith - 1]?.pattern}`;
          write(
            path,
            result,
            `  (opened with ${how}; bank guess: ${bank ?? 'unknown'})`,
          );
        } catch (error) {
          skipped.push([
            path,
            error instanceof PdfPasswordError
              ? 'that did not open it'
              : String(error),
          ]);
        }
      }
    }
  } finally {
    await server.close();
  }

  console.log(`\nDone: ${done.length} anonymized, ${skipped.length} skipped.`);
  for (const [path, why] of skipped)
    console.log(`  ✗ ${basename(path)}: ${why}`);
  if (done.length > 0)
    console.log('Read each .report.txt in inbox/synthetic/ before sharing.');
  process.exit(skipped.length > 0 && done.length === 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(
    `anonymize failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
