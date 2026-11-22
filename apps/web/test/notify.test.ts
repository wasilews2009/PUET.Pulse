import { afterEach, describe, expect, it, vi } from 'vitest';
import { showContentFreeNotification } from '../src/features/shell/notify';

describe('notifications', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Android: uses the service worker and stays content-free', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => Promise.resolve({ showNotification }) } });
    await showContentFreeNotification('c1', true);
    expect(ctor).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledWith('PUET.Pulse', { body: '❗', tag: 'c1', icon: '/icon-192.png' });
  });

  it('nothing is shown without permission', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'default' }));
    const showNotification = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => Promise.resolve({ showNotification }) } });
    await showContentFreeNotification('c1', false);
    expect(ctor).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });
});
