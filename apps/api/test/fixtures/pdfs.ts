import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

/** A small PDF with visible text. */
export async function plainPdf(text = 'Hello PUET', pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`${text} ${i + 1}`, { x: 50, y: 780, size: 18, font });
  return Buffer.from(await doc.save());
}

/**
 * A weaponized PDF: document JavaScript, OpenAction, a launch action, an
 * external link, page additional-actions, an embedded file and an XFA form.
 */
export async function maliciousPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Invoice', { x: 50, y: 780, size: 18, font });
  const ctx = doc.context;
  const js = ctx.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("pwned")') });
  const launch = ctx.obj({ Type: 'Action', S: 'Launch', F: PDFString.of('cmd.exe') });
  const uri = ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of('https://evil.example/steal') });
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 595, 842], A: ctx.register(uri) });
  const launchAnnot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: ctx.register(launch) });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(link), ctx.register(launchAnnot)]));
  page.node.set(PDFName.of('AA'), ctx.obj({ O: ctx.register(js) }));
  doc.catalog.set(PDFName.of('OpenAction'), ctx.register(js));
  const names = ctx.obj({ JavaScript: ctx.obj({ Names: [PDFString.of('x'), ctx.register(js)] }) });
  const embedded = ctx.flateStream('MZ fake executable', { Type: 'EmbeddedFile' });
  const spec = ctx.obj({ Type: 'Filespec', F: PDFString.of('payload.exe'), EF: ctx.obj({ F: ctx.register(embedded) }) });
  names.set(PDFName.of('EmbeddedFiles'), ctx.obj({ Names: [PDFString.of('payload.exe'), ctx.register(spec)] }));
  doc.catalog.set(PDFName.of('Names'), names);
  const xfa = ctx.flateStream('<xdp:xdp><script>evil()</script></xdp:xdp>');
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [], XFA: ctx.register(xfa) }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
