/**
 * Shows a content-free notification (it names neither the sender nor the text).
 * Through the service worker when there is one: Chrome on Android, and so the
 * Android app (Trusted Web Activity), refuses `new Notification()` in a page,
 * and service-worker notifications are the ones delegated to the installed app.
 */
export async function showContentFreeNotification(channelId: string, priority: boolean): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options: NotificationOptions = { body: priority ? '❗' : '', tag: channelId, icon: '/icon-192.png' };
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  if (reg) {
    await reg.showNotification('PUET.Pulse', options);
    return;
  }
  new Notification('PUET.Pulse', options);
}
