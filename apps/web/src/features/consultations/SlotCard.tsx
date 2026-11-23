import { MapPin, PhoneCall, VideoCamera } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { keys, useCard } from "../../api/queries";
import type { Slot } from "../../api/types";
import {
  Avatar,
  Badge,
  Button,
  cx,
  InlineError,
  Input,
} from "../../components/ui";
import { pick } from "../../i18n";
import { useCalls } from "../calls/CallContext";
import { roomOpen } from "../calls/call-utils";

function Person({ id, children }: { id: string; children?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const card = useCard(id);
  const name = card.data
    ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn)
    : t("chats.hiddenUser");
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar size="sm" id={id} name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate body-5">{name}</span>
        {children}
      </span>
    </span>
  );
}

export function HostName({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const card = useCard(id);
  return (
    <>
      {card.data
        ? pick(i18n.language, card.data.fullNameUk, card.data.fullNameEn)
        : t("chats.hiddenUser")}
    </>
  );
}

function when(s: Slot, lang: string) {
  const loc = lang === "en" ? "en-GB" : "uk-UA";
  const start = new Date(s.startsAt);
  const day = start.toLocaleDateString(loc, {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
  const from = start.toLocaleTimeString(loc, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const to = new Date(s.endsAt).toLocaleTimeString(loc, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return { day, range: `${from}–${to}` };
}

type View = "host" | "booked" | "browse";

/**
 * One consultation slot. `host`: the lecturer's own slot with who booked and why.
 * `booked`: a slot the student booked. `browse`: a lecturer's free time to book.
 */
export function SlotCard({ slot, view }: { slot: Slot; view: View }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const calls = useCalls();
  const [topic, setTopic] = useState("");
  const [asking, setAsking] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const { day, range } = when(slot, i18n.language);
  const cancelled = slot.status === "CANCELLED";
  const open = roomOpen(slot);
  const past = new Date(slot.endsAt).getTime() < Date.now();
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: keys.consultations });

  const book = useMutation({
    mutationFn: () =>
      api<Slot>(`/consultations/slots/${slot.id}/bookings`, {
        method: "POST",
        body: topic.trim() ? { topic: topic.trim() } : {},
      }),
    onSuccess: () => {
      setAsking(false);
      setTopic("");
      refresh();
    },
    onError: refresh,
  });
  const unbook = useMutation({
    mutationFn: () =>
      api(`/consultations/slots/${slot.id}/booking`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () =>
      api(`/consultations/slots/${slot.id}/cancel`, { method: "POST" }),
    onSuccess: refresh,
  });

  const join = async () => {
    setJoinFailed(false);
    try {
      await calls.join(
        { kind: "slot", slotId: slot.id },
        { title: `${t("consult.room")} · ${day}, ${range}`, canEnd: false },
      );
    } catch {
      setJoinFailed(true);
    }
  };

  return (
    <article
      className={cx(
        "flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line",
        cancelled && "opacity-70",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="title-3 first-letter:uppercase">{day}</span>
          <span className="body-6 text-muted">{range}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cancelled && <Badge tone="danger">{t("consult.cancelled")}</Badge>}
          <Badge tone={slot.mode === "ONLINE" ? "navy" : "neutral"}>
            {slot.mode === "ONLINE" ? (
              <VideoCamera size={14} aria-hidden="true" />
            ) : (
              <MapPin size={14} aria-hidden="true" />
            )}
            {slot.mode === "ONLINE" ? t("consult.mode.ONLINE") : slot.location}
          </Badge>
        </div>
      </header>

      {view !== "host" && (
        <p className="caption-2 text-muted">
          <HostName id={slot.hostId} />
        </p>
      )}
      {(slot.course || slot.note) && (
        <div className="flex flex-col gap-1">
          {slot.course && (
            <span className="caption-1">
              {pick(i18n.language, slot.course.nameUk, slot.course.nameEn)}
            </span>
          )}
          {slot.note && <span className="body-6 text-muted">{slot.note}</span>}
        </div>
      )}

      <p className="caption-4 text-muted">
        {t("consult.seats", { booked: slot.booked, capacity: slot.capacity })}
      </p>

      {view === "host" && slot.bookings && slot.bookings.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-line pt-3">
          {slot.bookings.map((b) => (
            <li key={b.id}>
              <Person id={b.studentId}>
                {b.topic && (
                  <span className="caption-5 text-muted">{b.topic}</span>
                )}
              </Person>
            </li>
          ))}
        </ul>
      )}
      {view === "booked" && slot.myBooking?.topic && (
        <p className="caption-5 text-muted">
          {t("consult.myTopic", { topic: slot.myBooking.topic })}
        </p>
      )}

      {asking && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            book.mutate();
          }}
        >
          <Input
            aria-label={t("consult.topic")}
            placeholder={t("consult.topicPlaceholder")}
            maxLength={200}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="accent"
              type="submit"
              loading={book.isPending}
            >
              {t("consult.confirmBooking")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              {t("app.cancel")}
            </Button>
          </div>
        </form>
      )}
      {book.isError && <InlineError>{t("consult.bookFailed")}</InlineError>}
      {joinFailed && <InlineError>{t("call.joinFailed")}</InlineError>}

      {!cancelled && !past && !asking && (
        <footer className="flex flex-wrap gap-2">
          {open && view !== "browse" && (
            <Button
              size="sm"
              variant="accent"
              icon={<PhoneCall size={16} aria-hidden="true" />}
              onClick={() => void join()}
            >
              {t("consult.joinRoom")}
            </Button>
          )}
          {view === "browse" &&
            (slot.myBooking ? (
              <Badge tone="success">{t("consult.youBooked")}</Badge>
            ) : slot.bookable ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setAsking(true)}
              >
                {t("consult.book")}
              </Button>
            ) : (
              <span className="caption-5 text-muted">
                {slot.booked >= slot.capacity
                  ? t("consult.full")
                  : t("consult.notForYou")}
              </span>
            ))}
          {view === "booked" && (
            <Button
              size="sm"
              variant="secondary"
              loading={unbook.isPending}
              onClick={() => unbook.mutate()}
            >
              {t("consult.cancelBooking")}
            </Button>
          )}
          {view === "host" && (
            <Button
              size="sm"
              variant="danger"
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t("consult.cancelSlot")}
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}
