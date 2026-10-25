/**
 * The app's PdfReader: pdf.js loaded on the first PDF only (it is most of
 * the bundle's weight), with its worker served from our own build — never a
 * CDN. One worker is shared by every file and password attempt in the page's
 * lifetime instead of one per attempt.
 */

import { readPdfText, type PdfJs } from '../parser';
import type { PdfReader } from './read';

let loading: Promise<{
  pdfjs: PdfJs;
  worker: InstanceType<PdfJs['PDFWorker']>;
}> | null = null;

function load() {
  loading ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, workerUrl]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
    return { pdfjs, worker: new pdfjs.PDFWorker() };
  });
  // A failed load (offline chunk fetch after a deploy) can be retried.
  loading.catch(() => (loading = null));
  return loading;
}

export const readPdfInBrowser: PdfReader = async (bytes, passwords) => {
  const { pdfjs, worker } = await load();
  return readPdfText(pdfjs, bytes, passwords, { worker });
};
