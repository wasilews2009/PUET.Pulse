import {
  CalendarBlank,
  CalendarCheck,
  CaretDown,
  Plus,
  Student,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useConsultationHosts,
  useHostSlots,
  useMyConsultations,
} from "../../api/queries";
import type { ConsultationHost } from "../../api/types";
import {
  Button,
  cx,
  EmptyState,
  InlineError,
  Skeleton,
} from "../../components/ui";
import { pick } from "../../i18n";
import { useMe } from "../../session/session";
import { canHostConsultations } from "../calls/call-utils";
import { NewSlotDialog } from "./NewSlotDialog";
import { HostName, SlotCard } from "./SlotCard";

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  );
}

function HostRow({ host }: { host: ConsultationHost }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const slots = useHostSlots(host.userId, open);
  const panel = `host-${host.userId}`;
  return (
    <li className="rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors duration-300 ease-pulse hover:bg-surface-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate title-3">
            <HostName id={host.userId} />
          </span>
          <span className="truncate caption-5 text-muted">
            {host.courses
              .map((c) => pick(i18n.language, c.nameUk, c.nameEn))
              .join(" · ")}
          </span>
        </span>
        <span className="shrink-0 caption-4 text-muted">
          {host.upcoming
            ? t("consult.upcoming", { count: host.upcoming })
            : t("consult.noneYet")}
        </span>
        <CaretDown
          size={18}
          aria-hidden="true"
          className={cx(
            "shrink-0 transition-transform duration-300 ease-pulse",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id={panel}
          className="flex flex-col gap-3 border-t border-line p-4"
        >
          {slots.isPending && <Loading />}
          {slots.isError && <InlineError>{t("app.error")}</InlineError>}
          {slots.data?.length === 0 && (
            <p className="body-6 text-muted">{t("consult.hostEmpty")}</p>
          )}
          {slots.data?.map((s) => (
            <SlotCard key={s.id} slot={s} view="browse" />
          ))}
        </div>
      )}
    </li>
  );
}

/** «Консультації»: the lecturer's schedule, the student's bookings and their lecturers' free time. */
export default function ConsultationsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const host = canHostConsultations(me);
  const mine = useMyConsultations();
  const hosts = useConsultationHosts();
  const [creating, setCreating] = useState(false);

  return (
    <main id="main" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="heading-5">{t("consult.title")}</h1>
            <p className="body-6 text-muted">
              {host ? t("consult.subtitleHost") : t("consult.subtitle")}
            </p>
          </div>
          {host && (
            <Button
              variant="accent"
              icon={<Plus size={18} aria-hidden="true" />}
              onClick={() => setCreating(true)}
            >
              {t("consult.add")}
            </Button>
          )}
        </header>

        {mine.isError && <InlineError>{t("app.error")}</InlineError>}

        {host && (
          <section
            aria-labelledby="consult-hosting"
            className="flex flex-col gap-3"
          >
            <h2 id="consult-hosting" className="heading-6">
              {t("consult.mySchedule")}
            </h2>
            {mine.isPending && <Loading />}
            {mine.data?.hosting.length === 0 && (
              <EmptyState
                icon={<CalendarBlank size={28} />}
                title={t("consult.hostingEmpty")}
                hint={t("consult.hostingEmptyHint")}
              />
            )}
            {mine.data?.hosting.map((s) => (
              <SlotCard key={s.id} slot={s} view="host" />
            ))}
          </section>
        )}

        {/* Lecturers rarely book: their bookings and lecturers appear only when there are some. */}
        {(!host || (mine.data?.booked.length ?? 0) > 0) && (
          <section
            aria-labelledby="consult-booked"
            className="flex flex-col gap-3"
          >
            <h2 id="consult-booked" className="heading-6">
              {t("consult.myBookings")}
            </h2>
            {mine.isPending && <Loading />}
            {mine.data?.booked.length === 0 && (
              <EmptyState
                icon={<CalendarCheck size={28} />}
                title={t("consult.bookedEmpty")}
                hint={t("consult.bookedEmptyHint")}
              />
            )}
            {mine.data?.booked.map((s) => (
              <SlotCard key={s.id} slot={s} view="booked" />
            ))}
          </section>
        )}

        {(!host || (hosts.data?.length ?? 0) > 0) && (
          <section
            aria-labelledby="consult-hosts"
            className="flex flex-col gap-3"
          >
            <h2 id="consult-hosts" className="heading-6">
              {t("consult.myLecturers")}
            </h2>
            {hosts.isPending && <Loading />}
            {hosts.isError && <InlineError>{t("app.error")}</InlineError>}
            {hosts.data?.length === 0 && (
              <EmptyState
                icon={<Student size={28} />}
                title={t("consult.lecturersEmpty")}
                hint={t("consult.lecturersEmptyHint")}
              />
            )}
            <ul className="flex flex-col gap-3">
              {hosts.data?.map((h) => (
                <HostRow key={h.userId} host={h} />
              ))}
            </ul>
          </section>
        )}
      </div>
      {host && (
        <NewSlotDialog open={creating} onClose={() => setCreating(false)} />
      )}
    </main>
  );
}
