import { PhoneCall, VideoCamera } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCall, useCard } from "../../api/queries";
import type { Channel } from "../../api/types";
import { Button, InlineError, Skeleton, formatTime } from "../../components/ui";
import { useMe } from "../../session/session";
import { channelName, encrypted, isModerator } from "../chat/channel-utils";
import { useCalls } from "./CallContext";
import { formatDuration } from "./call-utils";

/** Title of a channel for the call window (DMs show the other person). */
export function useChannelTitle(channel: Channel): string {
  const { t, i18n } = useTranslation();
  const peer = useCard(channel.type === "DIRECT" ? channel.peerId : null);
  return channelName(channel, i18n.language, peer.data, t("chats.hiddenUser"));
}

/** Options for joining a call of this channel. */
export function useCallOptions(channel: Channel, startedById: string | null) {
  const { t } = useTranslation();
  const me = useMe();
  const title = useChannelTitle(channel);
  return {
    title,
    // Encrypted chats: the call is protected in transit (DTLS-SRTP) but passes the university SFU.
    notice: encrypted(channel) ? t("call.notE2ee") : null,
    canEnd: startedById === me.userId || isModerator(channel),
  };
}

/** A call in the timeline: join while it runs, duration once it ended. */
export function CallCard({
  callId,
  channel,
}: {
  callId: string;
  channel: Channel;
}) {
  const { t, i18n } = useTranslation();
  const q = useCall(callId);
  const calls = useCalls();
  const options = useCallOptions(channel, q.data?.startedById ?? null);
  const [failed, setFailed] = useState(false);
  const [joining, setJoining] = useState(false);

  if (q.isPending) return <Skeleton className="h-16 w-64" />;
  if (q.isError || !q.data) return <InlineError>{t("app.error")}</InlineError>;
  const c = q.data;
  const live = c.endedAt === null;
  const inThisCall = calls.active?.join.callId === c.id;

  const join = async () => {
    setFailed(false);
    setJoining(true);
    try {
      await calls.join({ kind: "call", callId: c.id }, options);
    } catch {
      setFailed(true);
    } finally {
      setJoining(false);
    }
  };

  return (
    <section
      aria-label={t("call.title")}
      className="flex w-[min(22rem,100%)] flex-col gap-2 whitespace-normal"
    >
      <div className="flex items-center gap-3">
        <span
          className={
            live
              ? "flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
              : "flex size-10 shrink-0 items-center justify-center rounded-full bg-current/10"
          }
        >
          <VideoCamera
            size={20}
            weight={live ? "fill" : "regular"}
            aria-hidden="true"
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="body-4">{t("call.title")}</span>
          <span className="caption-4 opacity-80">
            {live
              ? t("call.liveSince", {
                  time: formatTime(c.startedAt, i18n.language),
                  count: c.participants.length,
                })
              : t("call.endedLine", {
                  duration: formatDuration(
                    new Date(c.endedAt!).getTime() -
                      new Date(c.startedAt).getTime(),
                    i18n.language,
                  ),
                  count: c.participants.length,
                })}
          </span>
        </span>
      </div>
      {live && !inThisCall && (
        <Button
          size="sm"
          variant="accent"
          className="self-start"
          loading={joining}
          icon={<PhoneCall size={16} aria-hidden="true" />}
          onClick={() => void join()}
        >
          {t("call.join")}
        </Button>
      )}
      {failed && <InlineError>{t("call.joinFailed")}</InlineError>}
    </section>
  );
}
