import { ChatsCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { isUuid } from '../../api/client';
import { useChannels } from '../../api/queries';
import { cx, EmptyState } from '../../components/ui';
import { NotFoundPage } from '../../pages/NotFoundPage';
import { ChannelList } from './ChannelList';
import { ChannelView } from './ChannelView';

/** Two panes on desktop; on a phone the list and the open chat replace each other. */
export function ChatsPage() {
  const { t } = useTranslation();
  const { channelId } = useParams();
  const channels = useChannels();
  const open = isUuid(channelId) ? channels.data?.find((c) => c.id === channelId) : undefined;
  const bad = channelId !== undefined && (!isUuid(channelId) || (channels.isSuccess && !open));

  return (
    <div className="flex min-h-0 flex-1">
      <div className={cx('min-h-0 w-full md:w-auto', channelId ? 'hidden md:block' : 'block')}>
        <ChannelList />
      </div>
      <main id="main" className={cx('min-h-0 min-w-0 flex-1 flex-col bg-canvas', channelId ? 'flex' : 'hidden md:flex')}>
        {bad ? (
          <NotFoundPage />
        ) : open ? (
          <ChannelView key={open.id} channel={open} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<ChatsCircle size={28} />} title={t('chats.pick')} hint={t('chats.pickHint')} />
          </div>
        )}
      </main>
    </div>
  );
}
