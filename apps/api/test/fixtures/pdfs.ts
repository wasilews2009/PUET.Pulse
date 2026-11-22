import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, type PDFRef } from 'pdf-lib';

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

/**
 * A PDF with an outline: a chapter with a sub-entry (explicit destinations), a
 * GoTo action entry with a hostile title, and entries that must be ignored
 * (a JavaScript action and a link to another file).
 */
export async function outlinedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3].map((n) => {
    const p = doc.addPage([595, 842]);
    p.drawText(`Section ${n} budget`, { x: 50, y: 780, size: 18, font });
    return p;
  });
  const ctx = doc.context;
  const root = ctx.nextRef();
  const refs = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
  const [ch1, sub, ch2, js, remote, ch3] = refs as [PDFRef, PDFRef, PDFRef, PDFRef, PDFRef, PDFRef];
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: ch1, Last: ch3, Count: 5 }));
  ctx.assign(ch1, ctx.obj({ Title: PDFHexString.fromText('Розділ 1. Загальні положення'), Parent: root, Next: ch2, First: sub, Last: sub, Count: 1, Dest: [pages[0]!.ref, PDFName.of('Fit')] }));
  ctx.assign(sub, ctx.obj({ Title: PDFString.of('1.1 Scope'), Parent: ch1, Dest: [pages[1]!.ref, PDFName.of('XYZ'), null, null, null] }));
  ctx.assign(ch2, ctx.obj({ Title: PDFHexString.fromText('Budget‮exe.pdf\u0007'), Parent: root, Prev: ch1, Next: js, A: ctx.obj({ S: 'GoTo', D: [pages[2]!.ref, PDFName.of('Fit')] }) }));
  ctx.assign(js, ctx.obj({ Title: PDFString.of('Run me'), Parent: root, Prev: ch2, Next: remote, A: ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }) }));
  ctx.assign(remote, ctx.obj({ Title: PDFString.of('Elsewhere'), Parent: root, Prev: js, Next: ch3, A: ctx.obj({ S: 'GoToR', F: PDFString.of('other.pdf'), D: [0, PDFName.of('Fit')] }) }));
  ctx.assign(ch3, ctx.obj({ Title: PDFString.of('Annex'), Parent: root, Prev: remote, Dest: [pages[2]!.ref, PDFName.of('Fit')] }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
