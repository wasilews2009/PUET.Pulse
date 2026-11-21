import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFObject,
} from 'pdf-lib';

/**
 * Content Disarm & Reconstruction for PDFs (CLAUDE.md §1.5).
 *
 * The document is rebuilt: only page content (content streams, resources) is
 * copied into a fresh document with a new catalog. Nothing else survives:
 * no document JavaScript, OpenAction, additional actions, AcroForm / XFA,
 * embedded files, outlines, named destinations or native annotations
 * (links, launch actions, rich media). Interactive form values are flattened
 * into the page first so a filled form keeps its visible content. Comments
 * live in the JSON annotation layer instead (pdf_annotations).
 *
 * Encrypted or unparsable PDFs are refused (CDR status FAILED, never served).
 */

export const MAX_PDF_PAGES = 2000;

/** Dictionary keys that can carry active content or point outside the document. */
const ACTIVE_KEYS = [
  'JS',
  'JavaScript',
  'AA',
  'OpenAction',
  'A',
  'Next',
  'AcroForm',
  'XFA',
  'Names',
  'Dests',
  'Outlines',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMediaContent',
  'RichMediaSettings',
  'URI',
  'Launch',
  'Annots',
  'StructTreeRoot',
  'Collection',
  'Threads',
  'B', // article beads
];

/** Action types that run code, open other files or reach the network. */
const ACTIVE_ACTION_TYPES = new Set([
  'JavaScript',
  'Launch',
  'URI',
  'SubmitForm',
  'ImportData',
  'ResetForm',
  'GoToR',
  'GoToE',
  'Rendition',
  'Sound',
  'Movie',
  'RichMediaExecute',
  'Hide',
  'Named',
  'Thread',
]);

export class PdfRejectedError extends Error {}

export interface SanitizedPdf {
  bytes: Buffer;
  pageCount: number;
}

export async function sanitizePdf(input: Buffer): Promise<SanitizedPdf> {
  try {
    return await rebuild(input);
  } catch (e) {
    if (e instanceof PdfRejectedError) throw e;
    // Any parser or copy failure means we cannot prove the result safe: refuse it.
    throw new PdfRejectedError('PDF cannot be sanitized');
  }
}

async function rebuild(input: Buffer): Promise<SanitizedPdf> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(input, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
  } catch {
    throw new PdfRejectedError('PDF cannot be parsed or is encrypted');
  }
  const pageCount = src.getPageCount();
  if (pageCount === 0 || pageCount > MAX_PDF_PAGES) throw new PdfRejectedError('Unsupported page count');

  // Keep what a filled form shows, then drop the form itself.
  try {
    src.getForm().flatten();
  } catch {
    // XFA-only or broken forms: their fields are dropped below.
  }

  // Detach active page-level entries before copying, so nothing unsafe is even carried over.
  for (const page of src.getPages()) {
    for (const key of ['Annots', 'AA', 'B', 'StructParents', 'Metadata', 'PieceInfo']) page.node.delete(PDFName.of(key));
  }

  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(src, src.getPageIndices());
  for (const p of copied) out.addPage(p);
  scrub(out);

  out.setProducer('PUET.Pulse CDR');
  out.setCreator('PUET.Pulse');
  const bytes = Buffer.from(await out.save({ useObjectStreams: false }));

  // Defense in depth: parse the result again and prove that nothing active is left.
  const check = await PDFDocument.load(bytes, { updateMetadata: false });
  const leftovers = findActiveContent(check);
  if (leftovers.length > 0) throw new PdfRejectedError('Active content survived sanitization');
  return { bytes, pageCount };
}

function scrub(doc: PDFDocument) {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    for (const key of ACTIVE_KEYS) dict.delete(PDFName.of(key));
  }
}

/**
 * Lists active constructs found anywhere in the document (catalog, pages, every
 * indirect object). Used after sanitization and by the tests.
 */
export function findActiveContent(doc: PDFDocument): string[] {
  const found = new Set<string>();
  const seen = new Set<PDFObject>();
  const visit = (o: PDFObject | undefined, depth: number) => {
    if (!o || depth > 64 || seen.has(o)) return;
    seen.add(o);
    if (o instanceof PDFRef) return visit(doc.context.lookup(o), depth + 1);
    if (o instanceof PDFArray) {
      for (const v of o.asArray()) visit(v, depth + 1);
      return;
    }
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!dict) return;
    for (const [k, v] of dict.entries()) {
      const name = k.decodeText();
      if (ACTIVE_KEYS.includes(name) && name !== 'Annots') found.add(`/${name}`);
      if (name === 'Annots') {
        const arr = v instanceof PDFRef ? doc.context.lookup(v) : v;
        // pdf-lib adds an empty /Annots array when it edits a page; only real annotations count.
        if (!(arr instanceof PDFArray) || arr.size() > 0) found.add('/Annots');
      }
      if (name === 'S' && v instanceof PDFName && ACTIVE_ACTION_TYPES.has(v.decodeText())) found.add(`/S /${v.decodeText()}`);
      if (name === 'Type' && v instanceof PDFName && ['Filespec', 'EmbeddedFile', 'Action'].includes(v.decodeText())) {
        found.add(`/Type /${v.decodeText()}`);
      }
      if (name === 'Subtype' && v instanceof PDFName && ['Link', 'RichMedia', 'FileAttachment', 'Widget', 'Screen', 'Movie', 'Sound'].includes(v.decodeText())) {
        found.add(`/Subtype /${v.decodeText()}`);
      }
      visit(v, depth + 1);
    }
  };
  visit(doc.catalog, 0);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj, 0);
  return [...found].sort();
}
