import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Channel } from '../../api/types';
import { enablePush, pushSupported, syncBadge } from './push';

const DISMISSED = 'pulse.push-prompt-dismissed';
const OPEN_PATH = /^\/chats(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

/**
 * Phone notifications and the app icon badge: refreshes this browser's push
 * subscription, keeps the badge equal to the unread count, opens the chat of a
 * tapped notification, and offers to turn notifications on once.
 */
export function usePhoneNotifications(channels: Channel[] | undefined, unread: number) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(() => pushSupported() && Notification.permission === 'default' && !wasDismissed());

  useEffect(() => {
    if (pushSupported() && Notification.permission === 'granted') void enablePush(false).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; path?: unknown } | null;
      if (d?.type === 'pulse.open' && typeof d.path === 'string' && OPEN_PATH.test(d.path)) void navigate(d.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    if (!channels) return;
    const read = new Set(channels.filter((c) => c.unread === 0).map((c) => c.id));
    void syncBadge(unread, read).catch(() => undefined);
  }, [channels, unread]);

  const enable = async () => {
    setPrompt(false);
    await enablePush(true).catch(() => undefined);
  };
  const dismiss = () => {
    setPrompt(false);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      /* private mode */
    }
  };
  return { prompt, enable, dismiss };
}
