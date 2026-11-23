import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { API_BASE } from '../../api/client';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Hardening shared by both loaders. The server already rebuilt the PDF (CDR);
 * the viewer adds defence in depth: no eval, no XFA, no scripting sandbox, no
 * external fonts or CMaps, nothing fetched by the document itself.
 */
const SAFE = {
  isEvalSupported: false,
  enableXfa: false,
  disableFontFace: false,
  useSystemFonts: false,
  stopAtErrors: false,
} as const;

/** Opens a PDF from bytes already in memory (confidential, watermarked copies are served whole). */
export function openPdf(bytes: Uint8Array) {
  return pdfjs.getDocument({ ...SAFE, data: bytes, disableAutoFetch: true, disableStream: true }).promise;
}

/**
 * Opens a non-confidential PDF page by page: PDF.js asks the API for byte ranges
 * and fetches only what the visible pages need. The responses are `no-store`,
 * so nothing lands in the HTTP cache; the session cookie travels same-origin.
 */
export function openPdfStream(fileId: string) {
  return pdfjs.getDocument({
    ...SAFE,
    url: `${API_BASE}/files/${fileId}/view`,
    withCredentials: true,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 128 * 1024,
  }).promise;
}

export type PdfDoc = Awaited<ReturnType<typeof openPdf>>;
