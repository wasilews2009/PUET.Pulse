import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Opens a PDF for the Secure Viewer. The server already rebuilt it (CDR), and
 * the viewer adds defence in depth: no eval, no XFA, no scripting sandbox, no
 * external fonts or CMaps, nothing fetched by the document itself.
 */
export function openPdf(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: false,
    useSystemFonts: false,
    stopAtErrors: false,
  }).promise;
}

export type PdfDoc = Awaited<ReturnType<typeof openPdf>>;
