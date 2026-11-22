import { describe, expect, it } from 'vitest';
import { ConfigError, navigationVerdict, parseConfig, permissionAllowed, SECURE_WEB_PREFERENCES } from '../src/policy';

const cfg = parseConfig({ PULSE_URL: 'https://pulse.puet.edu.ua/chats', PULSE_SSO_HOSTS: 'sso.puet.edu.ua, bad host' });

describe('desktop wrapper policy', () => {
  it('config: https only, no credentials, sign-in hosts sanitized', () => {
    expect(cfg).toEqual({ origin: 'https://pulse.puet.edu.ua', ssoHosts: ['sso.puet.edu.ua'] });
    expect(() => parseConfig({ PULSE_URL: 'http://pulse.puet.edu.ua' })).toThrow(ConfigError);
    expect(() => parseConfig({ PULSE_URL: 'https://u:p@pulse.puet.edu.ua' })).toThrow(ConfigError);
    expect(parseConfig({ PULSE_URL: 'http://localhost:5173' }).origin).toBe('http://localhost:5173');
  });

  it('phishing: the window shows only the server and the sign-in pages; other links go to the browser', () => {
    expect(navigationVerdict('https://pulse.puet.edu.ua/files/x', cfg)).toBe('allow');
    expect(navigationVerdict('https://sso.puet.edu.ua/realms/puet/auth', cfg)).toBe('allow');
    expect(navigationVerdict('https://pulse.puet.edu.ua.evil.example/', cfg)).toBe('external');
    expect(navigationVerdict('https://moodle.puet.edu.ua/course', cfg)).toBe('external');
  });

  it('RCE: file:, javascript:, data: and custom schemes are refused', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ms-msdt:/id', 'http://pulse.puet.edu.ua/', 'not a url']) {
      expect(navigationVerdict(u, cfg), u).toBe('deny');
    }
  });

  it('permissions: only calls and notifications, only for the server', () => {
    expect(permissionAllowed('media', 'https://pulse.puet.edu.ua/chats/1', cfg)).toBe(true);
    expect(permissionAllowed('notifications', 'https://pulse.puet.edu.ua/', cfg)).toBe(true);
    expect(permissionAllowed('geolocation', 'https://pulse.puet.edu.ua/', cfg)).toBe(false);
    expect(permissionAllowed('openExternal', 'https://pulse.puet.edu.ua/', cfg)).toBe(false);
    expect(permissionAllowed('media', 'https://evil.example/', cfg)).toBe(false);
  });

  it('every window runs without Node, isolated and sandboxed', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false });
  });
});
