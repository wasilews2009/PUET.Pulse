import {
  Microphone,
  MicrophoneSlash,
  Monitor,
  PhoneDisconnect,
  MonitorArrowUp,
  SpeakerHigh,
  VideoCamera,
  VideoCameraSlash,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type Participant,
  type RemoteParticipant,
  type Track as LkTrack,
} from "livekit-client";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useCard } from "../../api/queries";
import type { CallJoin } from "../../api/types";
import { Avatar, Button, cx } from "../../components/ui";
import { pick } from "../../i18n";
import { useMe } from "../../session/session";
import type { CallOptions } from "./CallContext";

type Phase = "connecting" | "connected" | "ended" | "removed" | "failed";

function VideoView({
  track,
  mirror,
  fit,
}: {
  track: LkTrack;
  mirror?: boolean;
  fit: "cover" | "contain";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cx(
        "size-full",
        fit === "cover" ? "object-cover" : "object-contain",
        mirror && "-scale-x-100",
      )}
    />
  );
}

function AudioView({ track }: { track: LkTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

function useName(p: Participant, local: boolean): string {
  const { t, i18n } = useTranslation();
  const me = useMe();
  // The SFU knows only user ids; names come from the same directory cards as everywhere else.
  const card = useCard(local ? null : p.identity);
  if (local) {
    const mine = pick(i18n.language, me.fullNameUk, me.fullNameEn);
    return mine ? `${mine} (${t("call.you")})` : t("call.you");
  }
  return card.data
    ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn)
    : t("chats.hiddenUser");
}

function Tile({ p, local }: { p: Participant; local: boolean }) {
  const { t } = useTranslation();
  const name = useName(p, local);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const video = cam && !cam.isMuted ? cam.track : undefined;
  return (
    <figure
      className={cx(
        "relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-call-tile ring-2 transition-[box-shadow] duration-300 ease-pulse",
        p.isSpeaking ? "ring-accent" : "ring-transparent",
      )}
    >
      {video ? (
        <VideoView track={video} mirror={local} fit="cover" />
      ) : (
        <Avatar id={p.identity} name={name} size="lg" />
      )}
      <figcaption className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-lg bg-black/60 px-2 py-1 caption-4 text-white">
        {!p.isMicrophoneEnabled && (
          <MicrophoneSlash size={14} aria-label={t("call.micOff")} />
        )}
        <span className="truncate">{name}</span>
      </figcaption>
    </figure>
  );
}

function ScreenTile({ p, local }: { p: Participant; local: boolean }) {
  const { t } = useTranslation();
  const name = useName(p, local);
  const pub = p.getTrackPublication(Track.Source.ScreenShare);
  if (!pub?.track) return null;
  return (
    <figure className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-call-tile">
      <VideoView track={pub.track} fit="contain" />
      <figcaption className="absolute top-2 left-2 rounded-lg bg-black/60 px-2 py-1 caption-4 text-white">
        {t("call.sharing", { name })}
      </figcaption>
    </figure>
  );
}

function Control({
  label,
  active,
  onClick,
  children,
  tone = "default",
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "flex size-12 items-center justify-center rounded-full transition-[background-color,transform] duration-300 ease-pulse active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none",
        tone === "danger"
          ? "bg-accent text-on-accent hover:bg-accent-hover"
          : active === false
            ? "bg-white text-black hover:bg-white/90"
            : "bg-white/15 text-white hover:bg-white/25",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The call itself: LiveKit room with camera, microphone and screen sharing. The join token
 * came from the API (5-minute validity); the server can remove anybody at any time.
 */
export default function CallRoom({
  join,
  title,
  notice,
  canEnd,
  onLeave,
}: CallOptions & { join: CallJoin; onLeave: () => void }) {
  const { t } = useTranslation();
  const [room] = useState(
    () => new Room({ adaptiveStream: true, dynacast: true }),
  );
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.AudioPlaybackStatusChanged,
    ] as const;
    for (const e of events) room.on(e, rerender);
    const onDisconnected = (reason?: DisconnectReason) => {
      if (!live) return;
      setPhase(
        reason === DisconnectReason.PARTICIPANT_REMOVED ? "removed" : "ended",
      );
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    room
      .connect(join.url, join.token)
      .then(async () => {
        if (!live) return;
        setPhase("connected");
        if (join.canPublish) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
          } catch {
            setDeviceError(t("call.noMic"));
          }
        }
        rerender();
      })
      .catch(() => live && setPhase("failed"));
    return () => {
      live = false;
      for (const e of events) room.off(e, rerender);
      room.off(RoomEvent.Disconnected, onDisconnected);
      void room.disconnect();
    };
  }, [room, join, t]);

  useEffect(() => leaveRef.current?.focus(), []);

  const me: LocalParticipant = room.localParticipant;
  const remotes: RemoteParticipant[] = [...room.remoteParticipants.values()];
  const everyone: Participant[] = [me, ...remotes];
  const sharing = everyone.filter(
    (p) => p.getTrackPublication(Track.Source.ScreenShare)?.track,
  );
  const canShare =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    "getDisplayMedia" in navigator.mediaDevices;

  const toggle = async (what: "mic" | "cam" | "screen") => {
    setDeviceError(null);
    try {
      if (what === "mic")
        await me.setMicrophoneEnabled(!me.isMicrophoneEnabled);
      if (what === "cam") await me.setCameraEnabled(!me.isCameraEnabled);
      if (what === "screen")
        await me.setScreenShareEnabled(!me.isScreenShareEnabled, {
          audio: true,
        });
    } catch {
      // Permission refused, or the person closed the picker.
      if (what !== "screen")
        setDeviceError(what === "mic" ? t("call.noMic") : t("call.noCam"));
    }
    rerender();
  };

  const endForAll = async () => {
    await api(`/calls/${join.callId}/end`, { method: "POST" }).catch(
      () => undefined,
    );
    onLeave();
  };

  const over = phase === "ended" || phase === "removed" || phase === "failed";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col bg-viewer text-white"
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate heading-6">{title}</h2>
          <p className="caption-5 text-white/70" aria-live="polite">
            {phase === "connecting"
              ? t("call.connecting")
              : phase === "connected"
                ? t("call.inCall", { count: everyone.length })
                : null}
          </p>
        </div>
        {canEnd && phase === "connected" && (
          <Button size="sm" variant="danger" onClick={() => void endForAll()}>
            {t("call.endForAll")}
          </Button>
        )}
      </header>
      {notice && (
        <p className="mx-4 mb-2 rounded-lg bg-white/10 px-3 py-2 caption-5 text-white/80">
          {notice}
        </p>
      )}

      {over ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          <WarningCircle
            size={40}
            aria-hidden="true"
            className="text-white/70"
          />
          <p className="body-3">
            {phase === "removed"
              ? t("call.removed")
              : phase === "failed"
                ? t("call.failed")
                : t("call.ended")}
          </p>
          <Button variant="secondary" onClick={onLeave}>
            {t("call.close")}
          </Button>
        </div>
      ) : (
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
          {sharing.map((p) => (
            <ScreenTile key={`screen-${p.identity}`} p={p} local={p === me} />
          ))}
          <div
            className={cx(
              "grid gap-3",
              sharing.length
                ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6"
                : everyone.length === 1
                  ? "mx-auto w-full max-w-3xl grid-cols-1"
                  : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
            )}
          >
            {everyone.map((p) => (
              <Tile key={p.identity} p={p} local={p === me} />
            ))}
          </div>
          {remotes.flatMap((p) =>
            [Track.Source.Microphone, Track.Source.ScreenShareAudio].map(
              (src) => {
                const track = p.getTrackPublication(src)?.track;
                return track ? (
                  <AudioView key={`${p.identity}-${src}`} track={track} />
                ) : null;
              },
            ),
          )}
        </main>
      )}

      {!over && (
        <footer className="flex flex-col items-center gap-2 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {deviceError && (
            <p className="caption-4 text-white/80">{deviceError}</p>
          )}
          {!room.canPlaybackAudio && (
            <Button
              size="sm"
              variant="secondary"
              icon={<SpeakerHigh size={16} aria-hidden="true" />}
              onClick={() => void room.startAudio().then(rerender)}
            >
              {t("call.enableAudio")}
            </Button>
          )}
          <div className="flex items-center gap-3">
            {join.canPublish && (
              <>
                <Control
                  label={
                    me.isMicrophoneEnabled
                      ? t("call.muteMic")
                      : t("call.unmuteMic")
                  }
                  active={me.isMicrophoneEnabled}
                  onClick={() => void toggle("mic")}
                >
                  {me.isMicrophoneEnabled ? (
                    <Microphone size={24} />
                  ) : (
                    <MicrophoneSlash size={24} />
                  )}
                </Control>
                <Control
                  label={
                    me.isCameraEnabled ? t("call.camOff") : t("call.camOn")
                  }
                  active={me.isCameraEnabled}
                  onClick={() => void toggle("cam")}
                >
                  {me.isCameraEnabled ? (
                    <VideoCamera size={24} />
                  ) : (
                    <VideoCameraSlash size={24} />
                  )}
                </Control>
                {canShare && (
                  <Control
                    label={
                      me.isScreenShareEnabled
                        ? t("call.stopShare")
                        : t("call.share")
                    }
                    active={me.isScreenShareEnabled ? false : undefined}
                    onClick={() => void toggle("screen")}
                  >
                    {me.isScreenShareEnabled ? (
                      <Monitor size={24} />
                    ) : (
                      <MonitorArrowUp size={24} />
                    )}
                  </Control>
                )}
              </>
            )}
            <Control label={t("call.leave")} tone="danger" onClick={onLeave}>
              <PhoneDisconnect size={24} />
            </Control>
          </div>
          {!join.canPublish && (
            <p className="caption-5 text-white/70">{t("call.listenOnly")}</p>
          )}
          <button
            ref={leaveRef}
            type="button"
            className="sr-only"
            onClick={onLeave}
          >
            {t("call.leave")}
          </button>
        </footer>
      )}
    </div>
  );
}
