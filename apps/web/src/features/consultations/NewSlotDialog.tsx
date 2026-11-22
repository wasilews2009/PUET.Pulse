import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import { keys, useMyCourses } from "../../api/queries";
import type { Slot } from "../../api/types";
import {
  Button,
  Dialog,
  Field,
  InlineError,
  Input,
  Select,
  TextArea,
} from "../../components/ui";
import { pick } from "../../i18n";

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const REPEATS = [1, 2, 4, 8, 12, 16];

function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A lecturer publishes consultation time: once or weekly, online or in an auditorium. */
export function NewSlotDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const courses = useMyCourses(open);
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("14:00");
  const [duration, setDuration] = useState(30);
  const [capacity, setCapacity] = useState("1");
  const [mode, setMode] = useState<"ONLINE" | "OFFLINE">("ONLINE");
  const [location, setLocation] = useState("");
  const [course, setCourse] = useState("");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // The browser's local time (Europe/Kyiv on university devices) becomes an exact instant.
  const startsAt = new Date(`${date}T${time}`);
  const inFuture =
    !Number.isNaN(startsAt.getTime()) && startsAt.getTime() > Date.now();
  const seats = Number(capacity);
  const valid =
    inFuture &&
    seats >= 1 &&
    seats <= 50 &&
    (mode === "ONLINE" || location.trim().length > 0);

  const create = useMutation({
    mutationFn: () =>
      api<Slot[]>("/consultations/slots", {
        method: "POST",
        body: {
          startsAt: startsAt.toISOString(),
          durationMinutes: duration,
          capacity: seats,
          mode,
          ...(mode === "OFFLINE" ? { location: location.trim() } : {}),
          ...(course ? { courseOfferingId: course } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          repeatWeeks: repeat,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.consultations });
      setError(null);
      onClose();
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.status === 409
          ? t("consult.overlap")
          : t("consult.createFailed"),
      ),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("consult.newTitle")}
      footer={
        <Button
          variant="accent"
          disabled={!valid}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          {t("consult.publish")}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        {error && <InlineError>{error}</InlineError>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("consult.date")}>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={date}
                min={tomorrow()}
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t("consult.time")}
            error={inFuture ? undefined : t("consult.pastTime")}
          >
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="time"
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("consult.duration")}>
            {(id) => (
              <Select
                id={id}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {DURATIONS.map((m) => (
                  <option key={m} value={m}>
                    {t("consult.minutes", { count: m })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("consult.capacity")} hint={t("consult.capacityHint")}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={capacity}
                onChange={(e) =>
                  setCapacity(e.target.value.replace(/\D/g, "").slice(0, 2))
                }
              />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 title-4">{t("consult.format")}</legend>
          {(["ONLINE", "OFFLINE"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 body-6">
              <input
                type="radio"
                name="slot-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-[var(--pulse-accent)]"
              />
              {t(`consult.mode.${m}`)}
            </label>
          ))}
        </fieldset>
        {mode === "OFFLINE" && (
          <Field label={t("consult.location")}>
            {(id) => (
              <Input
                id={id}
                maxLength={120}
                placeholder={t("consult.locationPlaceholder")}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            )}
          </Field>
        )}

        <Field label={t("consult.course")} hint={t("consult.courseHint")}>
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={course}
              onChange={(e) => setCourse(e.target.value)}
            >
              <option value="">{t("consult.anyCourse")}</option>
              {(courses.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {pick(i18n.language, c.nameUk, c.nameEn)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("consult.repeat")}>
          {(id) => (
            <Select
              id={id}
              value={repeat}
              onChange={(e) => setRepeat(Number(e.target.value))}
            >
              {REPEATS.map((n) => (
                <option key={n} value={n}>
                  {n === 1
                    ? t("consult.once")
                    : t("consult.weeks", { count: n })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("consult.note")}>
          {(id) => (
            <TextArea
              id={id}
              rows={2}
              maxLength={300}
              placeholder={t("consult.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
