import { minorContentFlags } from '@puet/shared';
import { describe, expect, it } from 'vitest';

describe('content filter for minors', () => {
  it('minor protection: obscene words are caught through look-alikes, separators, masks and repeats', () => {
    for (const t of ['ти хуйло', 'Пішов на х у й', 'ХУУУУЙ', 'xyй', 'пиздець', 'ебаний', 'блять', 'сука ти', 'мудак', 'підор', 'fuck you', 'ShIt happens', 'b1tch', 'це гівно', 'х*й', 'ху.й', 'нах*й', 'с*ка', 'похую', 'йобаний']) {
      expect(minorContentFlags(t), t).toEqual(['PROFANITY']);
    }
  });

  it('ordinary Ukrainian, Russian and English words pass', () => {
    for (const t of ['сухий хліб', 'Страхування', 'худий', 'Іван Драч', 'сукня гарна', 'блакитний', 'небо', 'себе', 'педагог', 'похудеть', 'Scunthorpe', 'хутір', 'шитво', 'ухилятися', 'педаль', 'застрахую', 'бляха-муха', '5*3=15', 'Hello, how are you?']) {
      expect(minorContentFlags(t), t).toEqual([]);
    }
  });

  it('phishing: only university links reach minors unless the sender may post links', () => {
    expect(minorContentFlags('https://casino.example/bonus')).toEqual(['EXTERNAL_LINK']);
    expect(minorContentFlags('www.t.me/joinchat/x')).toEqual(['EXTERNAL_LINK']);
    expect(minorContentFlags('https://puet.edu.ua.evil.example/')).toEqual(['EXTERNAL_LINK']);
    expect(minorContentFlags('Розклад https://puet.edu.ua/r та https://moodle.puet.edu.ua/c')).toEqual([]);
    expect(minorContentFlags('https://zoom.us/j/1', { allowedLinkHosts: ['zoom.us'] })).toEqual([]);
    expect(minorContentFlags('https://example.com', { allowLinks: true })).toEqual([]);
  });
});
