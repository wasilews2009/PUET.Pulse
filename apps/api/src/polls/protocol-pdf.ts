import { PDFDocument, rgb } from 'pdf-lib';
import { TextWriter } from '../files/fonts';

export type Lang = 'uk' | 'en';

export interface ProtocolData {
  pollId: string;
  /** The collegial body (channel name). */
  body: string;
  question: string;
  mode: 'OPEN' | 'SECRET';
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string | null;
  eligible: number;
  quorum: number;
  participants: number;
  /** FOR, AGAINST, ABSTAIN. */
  counts: number[];
  quorumReached: boolean;
  adopted: boolean;
  participantNames: string[];
  /** OPEN votes only: names per answer (roll call). */
  rollCall: string[][] | null;
  digest: string;
}

const T = {
  uk: {
    title: 'Протокол голосування',
    body: 'Колегіальний орган',
    question: 'Питання',
    mode: 'Вид голосування',
    open: 'відкрите (поіменне)',
    secret: 'таємне',
    openedAt: 'Відкрито',
    closedAt: 'Завершено',
    openedBy: 'Ініціатор',
    closedBy: 'Завершив',
    auto: 'автоматично за розкладом',
    eligible: 'Мають право голосу',
    quorum: 'Кворум',
    participants: 'Взяли участь',
    reached: 'кворум є',
    notReached: 'кворуму немає',
    results: 'Результати',
    answers: ['За', 'Проти', 'Утримались'],
    decision: 'Рішення',
    adopted: 'ПРИЙНЯТО',
    rejected: 'НЕ ПРИЙНЯТО',
    noQuorum: 'НЕ ПРИЙНЯТО (немає кворуму)',
    roll: 'Поіменні результати',
    voted: 'Учасники голосування',
    secretNote: 'Таємне голосування: система зберігає лише кількість голосів за кожен варіант, без зв’язку з учасниками.',
    digest: 'Контрольна сума результату (SHA-256)',
    id: 'Ідентифікатор голосування',
    signature: 'Вчений секретар  ____________________',
    none: '—',
  },
  en: {
    title: 'Voting protocol',
    body: 'Collegial body',
    question: 'Question',
    mode: 'Type of vote',
    open: 'open (roll call)',
    secret: 'secret ballot',
    openedAt: 'Opened',
    closedAt: 'Closed',
    openedBy: 'Initiated by',
    closedBy: 'Closed by',
    auto: 'automatically at the deadline',
    eligible: 'Entitled to vote',
    quorum: 'Quorum',
    participants: 'Took part',
    reached: 'quorum present',
    notReached: 'no quorum',
    results: 'Results',
    answers: ['For', 'Against', 'Abstained'],
    decision: 'Decision',
    adopted: 'ADOPTED',
    rejected: 'NOT ADOPTED',
    noQuorum: 'NOT ADOPTED (no quorum)',
    roll: 'Roll call',
    voted: 'Participants',
    secretNote: 'Secret ballot: the system stores only the number of votes per answer, with no link to participants.',
    digest: 'Result checksum (SHA-256)',
    id: 'Vote id',
    signature: 'Academic Secretary  ____________________',
    none: '—',
  },
} as const;

const time = (iso: string) => `${iso.replace('T', ' ').slice(0, 16)} UTC`;

/** Wraps text to lines no wider than `max` points. */
async function wrap(w: TextWriter, text: string, size: number, max: number, weight: 400 | 600 = 400): Promise<string[]> {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && (await w.width(next, size, weight)) > max) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** A4 protocol of a formal vote for the Academic Secretary (Inter, PUET navy). */
export async function protocolPdf(p: ProtocolData, lang: Lang): Promise<Buffer> {
  const t = T[lang];
  const doc = await PDFDocument.create();
  doc.setTitle(t.title);
  doc.setProducer('PUET.Pulse');
  const w = TextWriter.attach(doc);
  const navy = rgb(0x16 / 255, 0x3c / 255, 0x56 / 255);
  const terracotta = rgb(0xdf / 255, 0x48 / 255, 0x27 / 255);
  const ink = rgb(0.1, 0.12, 0.14);
  const muted = rgb(0.38, 0.42, 0.46);
  let page = doc.addPage([595, 842]);
  let y = 780;
  const ensure = (need: number) => {
    if (y - need < 60) {
      page = doc.addPage([595, 842]);
      y = 790;
    }
  };
  const row = async (label: string, value: string, color = ink, weight: 400 | 600 = 400) => {
    const lines = await wrap(w, value, 10, 340, weight);
    ensure(14 * lines.length);
    await w.draw(page, label, { x: 48, y, size: 9, color: muted });
    for (const l of lines) {
      await w.draw(page, l, { x: 210, y, size: 10, color, weight });
      y -= 14;
    }
    y -= 2;
  };
  const heading = async (text: string) => {
    ensure(30);
    y -= 8;
    await w.draw(page, text, { x: 48, y, size: 11, color: navy, weight: 600 });
    y -= 18;
  };

  page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: navy });
  await w.draw(page, 'ПУЕТ · PUET.Pulse', { x: 48, y: 822, size: 10, color: rgb(1, 1, 1), weight: 600 });
  await w.draw(page, t.title, { x: 48, y, size: 16, color: navy, weight: 600 });
  y -= 28;

  await row(t.body, p.body || t.none);
  await row(t.question, p.question, ink, 600);
  await row(t.mode, p.mode === 'OPEN' ? t.open : t.secret);
  await row(t.openedAt, time(p.openedAt));
  await row(t.closedAt, time(p.closedAt));
  await row(t.openedBy, p.openedBy);
  await row(t.closedBy, p.closedBy ?? t.auto);
  await row(t.eligible, String(p.eligible));
  await row(t.quorum, `${p.quorum} (${p.quorumReached ? t.reached : t.notReached})`, p.quorumReached ? ink : terracotta);
  await row(t.participants, String(p.participants));

  await heading(t.results);
  for (const [i, label] of t.answers.entries()) await row(label, String(p.counts[i] ?? 0), ink, 600);
  await row(t.decision, !p.quorumReached ? t.noQuorum : p.adopted ? t.adopted : t.rejected, p.adopted ? navy : terracotta, 600);

  if (p.rollCall) {
    await heading(t.roll);
    for (const [i, label] of t.answers.entries()) await row(label, p.rollCall[i]?.length ? p.rollCall[i]!.join(', ') : t.none);
  } else {
    ensure(30);
    for (const l of await wrap(w, t.secretNote, 9, 499)) {
      await w.draw(page, l, { x: 48, y, size: 9, color: muted });
      y -= 13;
    }
  }

  await heading(`${t.voted} (${p.participantNames.length})`);
  for (const l of await wrap(w, p.participantNames.join(', ') || t.none, 9, 499)) {
    ensure(13);
    await w.draw(page, l, { x: 48, y, size: 9, color: ink });
    y -= 13;
  }

  ensure(70);
  y -= 16;
  await w.draw(page, t.id, { x: 48, y, size: 8, color: muted });
  await w.draw(page, p.pollId, { x: 210, y, size: 8, color: ink });
  y -= 12;
  await w.draw(page, t.digest, { x: 48, y, size: 8, color: muted });
  await w.draw(page, p.digest.slice(0, 32), { x: 210, y, size: 8, color: ink });
  y -= 11;
  await w.draw(page, p.digest.slice(32), { x: 210, y, size: 8, color: ink });
  y -= 36;
  await w.draw(page, t.signature, { x: 48, y, size: 10, color: ink });
  return Buffer.from(await doc.save());
}
