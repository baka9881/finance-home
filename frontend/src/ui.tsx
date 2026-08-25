import {
  type ChangeEvent,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { twMerge } from "tailwind-merge";
import { taipeiDateInputValue, taipeiMonthInputValue } from "./date";

export const cn = (...values: (string | false | null | undefined)[]) =>
  twMerge(values.filter(Boolean).join(" "));

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-slate-200/80 bg-white shadow-soft", className)}>
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const styles = {
    primary: "bg-forest text-white hover:bg-[#205245] shadow-sm",
    secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
    ghost: "text-slate-600 hover:bg-slate-100",
    danger: "bg-red-50 text-red-700 hover:bg-red-100",
  };
  return (
    <button
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  type,
  inputMode,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 min-w-0 w-full max-w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10",
        className,
      )}
      type={type}
      inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)}
      {...props}
    />
  );
}

type PickerInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

const normalizePickerValue = (value: PickerInputProps["value"] | PickerInputProps["defaultValue"]) =>
  typeof value === "string" ? value : "";

const notifyPickerChange = (
  onChange: PickerInputProps["onChange"],
  nextValue: string,
) => {
  if (!onChange) return;
  const target = { value: nextValue } as HTMLInputElement;
  onChange({ target, currentTarget: target } as ChangeEvent<HTMLInputElement>);
};

function PickerPopover({
  open,
  anchorRef,
  title,
  estimatedHeight,
  onClose,
  children,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  title: string;
  estimatedHeight: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const [position, setPosition] = useState({ left: 12, top: 12, width: 320, compact: false });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const compact = window.innerWidth < 640;
      if (!rect || compact) {
        setPosition({ left: 12, top: 12, width: Math.max(280, window.innerWidth - 24), compact });
        return;
      }
      const width = Math.min(320, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const below = rect.bottom + 8;
      const top = below + estimatedHeight <= window.innerHeight
        ? below
        : Math.max(12, rect.top - estimatedHeight - 8);
      setPosition({ left, top, width, compact: false });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, estimatedHeight, open]);

  useEffect(() => {
    if (!open) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [onClose, open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[120] bg-slate-950/15 sm:bg-transparent"
      onMouseDown={onClose}
    >
      <section
        className={cn(
          "fixed border border-slate-200 bg-white p-4 text-slate-800 shadow-2xl",
          position.compact
            ? "inset-x-3 bottom-[calc(.75rem+env(safe-area-inset-bottom,0px))] rounded-3xl"
            : "rounded-2xl",
        )}
        style={position.compact ? undefined : { left: position.left, top: position.top, width: position.width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between sm:hidden">
          <p className="text-sm font-semibold">{title}</p>
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
            aria-label="關閉日期選擇器"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}

const pickerIconButton =
  "flex size-9 shrink-0 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-emerald-500/10";

export function DateInput({
  className,
  value,
  defaultValue,
  disabled,
  min,
  max,
  onChange,
  name,
  id,
  required,
  form,
  ...props
}: PickerInputProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(normalizePickerValue(defaultValue));
  const rawValue = value === undefined ? uncontrolledValue : normalizePickerValue(value);
  const fallback = rawValue || taipeiDateInputValue();
  const parsed = fallback.split("-").map(Number);
  const [viewYear, setViewYear] = useState(parsed[0]);
  const [viewMonth, setViewMonth] = useState(parsed[1]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [year, month, day] = rawValue.split("-");
  const today = taipeiDateInputValue();
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const leadingDays = (new Date(viewYear, viewMonth - 1, 1).getDay() + 6) % 7;
  const displayValue = year && month && day
    ? `${year}年${Number(month)}月${Number(day)}日`
    : "選擇日期";

  useEffect(() => {
    if (!rawValue) return;
    const [nextYear, nextMonth] = rawValue.split("-").map(Number);
    setViewYear(nextYear);
    setViewMonth(nextMonth);
  }, [rawValue]);

  const commit = (nextValue: string) => {
    if (value === undefined) setUncontrolledValue(nextValue);
    notifyPickerChange(onChange, nextValue);
    setOpen(false);
  };
  const changeMonth = (offset: number) => {
    const next = new Date(viewYear, viewMonth - 1 + offset, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth() + 1);
  };

  return (
    <>
      <button
        ref={anchorRef}
        id={id}
        type="button"
        className={cn(
          "flex h-11 min-w-0 w-full max-w-full items-center rounded-xl border border-slate-200 bg-white px-3 text-left text-sm text-slate-800 outline-none transition hover:border-slate-300 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={props["aria-label"] || "選擇日期"}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cn("min-w-0 flex-1 truncate", !rawValue && "text-slate-400")}>{displayValue}</span>
        <CalendarDays className="ml-3 shrink-0 text-slate-500" size={16} aria-hidden="true" />
      </button>
      <input type="hidden" name={name} value={rawValue} required={required} form={form} />
      <PickerPopover
        open={open}
        anchorRef={anchorRef}
        title="選擇日期"
        estimatedHeight={390}
        onClose={() => setOpen(false)}
      >
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={pickerIconButton} aria-label="上一個月" onClick={() => changeMonth(-1)}>
            <ChevronLeft size={19} />
          </button>
          <p className="font-semibold tabular-nums">{viewYear}年 {viewMonth}月</p>
          <button type="button" className={pickerIconButton} aria-label="下一個月" onClick={() => changeMonth(1)}>
            <ChevronRight size={19} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-400">
          {['一', '二', '三', '四', '五', '六', '日'].map((label) => <span key={label} className="py-1">{label}</span>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: leadingDays }, (_, index) => <span key={`empty-${index}`} />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const currentDay = index + 1;
            const dateValue = `${viewYear}-${String(viewMonth).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`;
            const selected = dateValue === rawValue;
            const isToday = dateValue === today;
            const unavailable = (typeof min === "string" && dateValue < min) || (typeof max === "string" && dateValue > max);
            return (
              <button
                key={dateValue}
                type="button"
                disabled={unavailable}
                className={cn(
                  "relative flex aspect-square items-center justify-center rounded-xl text-sm tabular-nums transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-25",
                  selected && "bg-forest font-semibold text-white hover:bg-forest",
                  !selected && isToday && "font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-300",
                )}
                aria-label={`${viewYear}年${viewMonth}月${currentDay}日`}
                aria-pressed={selected}
                onClick={() => commit(dateValue)}
              >
                {currentDay}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
          {!required ? (
            <button type="button" className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100" onClick={() => commit("")}>清除</button>
          ) : <span />}
          <button type="button" className="rounded-lg px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50" onClick={() => commit(today)}>今天</button>
        </div>
      </PickerPopover>
    </>
  );
}

export function MonthInput({
  className,
  value,
  defaultValue,
  disabled,
  min,
  max,
  onChange,
  name,
  id,
  required,
  form,
  ...props
}: PickerInputProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(normalizePickerValue(defaultValue));
  const rawValue = value === undefined ? uncontrolledValue : normalizePickerValue(value);
  const [year, month] = rawValue.split("-");
  const currentMonth = taipeiMonthInputValue();
  const [viewYear, setViewYear] = useState(Number(year || currentMonth.slice(0, 4)));
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const displayValue = year && month ? `${year}年${Number(month)}月` : "選擇月份";

  useEffect(() => {
    if (year) setViewYear(Number(year));
  }, [year]);

  const commit = (nextValue: string) => {
    if (value === undefined) setUncontrolledValue(nextValue);
    notifyPickerChange(onChange, nextValue);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        id={id}
        type="button"
        className={cn(
          "flex h-11 min-w-0 w-full max-w-full items-center rounded-xl border border-slate-200 bg-white px-3 text-left text-sm text-slate-800 outline-none transition hover:border-slate-300 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={props["aria-label"] || "選擇月份"}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cn("min-w-0 flex-1 truncate", !rawValue && "text-slate-400")}>{displayValue}</span>
        <CalendarDays className="ml-3 shrink-0 text-slate-500" size={16} aria-hidden="true" />
      </button>
      <input type="hidden" name={name} value={rawValue} required={required} form={form} />
      <PickerPopover
        open={open}
        anchorRef={anchorRef}
        title="選擇月份"
        estimatedHeight={320}
        onClose={() => setOpen(false)}
      >
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={pickerIconButton} aria-label="上一年" onClick={() => setViewYear((current) => current - 1)}>
            <ChevronLeft size={19} />
          </button>
          <p className="font-semibold tabular-nums">{viewYear}年</p>
          <button type="button" className={pickerIconButton} aria-label="下一年" onClick={() => setViewYear((current) => current + 1)}>
            <ChevronRight size={19} />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {Array.from({ length: 12 }, (_, index) => {
            const current = index + 1;
            const monthValue = `${viewYear}-${String(current).padStart(2, "0")}`;
            const selected = monthValue === rawValue;
            const isCurrent = monthValue === currentMonth;
            const unavailable = (typeof min === "string" && monthValue < min) || (typeof max === "string" && monthValue > max);
            return (
              <button
                key={monthValue}
                type="button"
                disabled={unavailable}
                className={cn(
                  "rounded-xl px-2 py-3 text-sm font-medium transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-25",
                  selected && "bg-forest text-white hover:bg-forest",
                  !selected && isCurrent && "text-emerald-700 ring-1 ring-inset ring-emerald-300",
                )}
                aria-pressed={selected}
                onClick={() => commit(monthValue)}
              >
                {current}月
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
          {!required ? (
            <button type="button" className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100" onClick={() => commit("")}>清除</button>
          ) : <span />}
          <button type="button" className="rounded-lg px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50" onClick={() => commit(currentMonth)}>本月</button>
        </div>
      </PickerPopover>
    </>
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 min-w-0 w-full max-w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block min-w-0 max-w-full space-y-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function FormStep({
  number,
  title,
  description,
  children,
  tone = "green",
}: {
  number: number;
  title: string;
  description?: string;
  children: ReactNode;
  tone?: "green" | "blue" | "purple";
}) {
  const tones = {
    green: "bg-emerald-100 text-emerald-700",
    blue: "bg-blue-100 text-blue-700",
    purple: "bg-purple-100 text-purple-700",
  };
  return (
    <section className="min-w-0 max-w-full space-y-4 rounded-2xl border border-slate-200 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", tones[tone])}>
          {number}
        </span>
        <div>
          <p className="font-semibold text-slate-800">{title}</p>
          {description && <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function FormContext({
  label = "目前操作",
  value,
  action,
}: {
  label?: string;
  value: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
      <div>
        <p className="text-xs text-slate-400">{label}</p>
        <p className="text-sm font-semibold text-slate-800">{value}</p>
      </div>
      {action}
    </div>
  );
}

export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  size = "md",
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: "md" | "lg" | "xl";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  const widths = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-5xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn("flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden rounded-none bg-white shadow-2xl outline-none sm:h-auto sm:max-h-[92vh] sm:rounded-3xl", widths[size])}
      >
        <div className="z-10 flex shrink-0 items-start justify-between border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6 sm:py-5">
          <div>
            <h2 id={titleId} className="text-xl font-bold text-ink">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="關閉"
          >
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-0 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-xl bg-slate-200/70", className)} />;
}

export function MobileWizardProgress({
  current,
  labels,
}: {
  current: number;
  labels: string[];
}) {
  return (
    <div className="sm:hidden">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold text-emerald-700">步驟 {current} / {labels.length}</span>
        <span className="text-slate-500">{labels[current - 1]}</span>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
        {labels.map((label, index) => (
          <span
            key={label}
            className={cn("h-1.5 rounded-full transition", index < current ? "bg-emerald-500" : "bg-slate-100")}
          />
        ))}
      </div>
    </div>
  );
}

export function MobileWizardStep({
  step,
  current,
  children,
}: {
  step: number;
  current: number;
  children: ReactNode;
}) {
  return (
    <div data-wizard-step={step} className={cn(step === current ? "block" : "hidden", "sm:block")}>
      {children}
    </div>
  );
}

export function validateWizardStep(form: HTMLFormElement | null, step: number) {
  const container = form?.querySelector<HTMLElement>(`[data-wizard-step="${step}"]`);
  if (!container) return true;
  const controls = Array.from(
    container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"),
  );
  for (const control of controls) {
    if (control.disabled || control.checkValidity()) continue;
    control.reportValidity();
    control.focus();
    return false;
  }
  return true;
}

export function MobileWizardActions({
  current,
  total,
  onPrevious,
  onNext,
  onCancel,
  submitLabel,
  pending = false,
  submitDisabled = false,
}: {
  current: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onCancel: () => void;
  submitLabel: string;
  pending?: boolean;
  submitDisabled?: boolean;
}) {
  return (
    <>
      <div className="mobile-safe-actions sticky bottom-0 z-20 -mx-4 mt-5 flex gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur sm:hidden">
        <Button type="button" variant="secondary" className="flex-1" onClick={current === 1 ? onCancel : onPrevious}>
          {current === 1 ? "取消" : <><ChevronLeft size={16} /> 上一步</>}
        </Button>
        {current < total ? (
          <Button type="button" className="flex-1" onClick={onNext}>
            下一步 <ChevronRight size={16} />
          </Button>
        ) : (
          <Button type="submit" className="flex-1" disabled={pending || submitDisabled}>{submitLabel}</Button>
        )}
      </div>
      <div className="hidden justify-end gap-3 pt-2 sm:flex">
        <Button type="button" variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={pending || submitDisabled}>{submitLabel}</Button>
      </div>
    </>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 rounded-2xl bg-emerald-50 p-4 text-emerald-700">{icon}</div>
      <h3 className="font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        {eyebrow && (
          <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-emerald-700">{eyebrow}</p>
        )}
        <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{description}</p>
      </div>
      {action}
    </header>
  );
}

export const money = (value: number, currency = "TWD") => {
  const amount = value || 0;
  if (currency === "TWD") {
    const sign = amount < 0 ? "-" : "";
    return `${sign}NT$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(Math.abs(amount))}`;
  }
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
};

export const number = (value: number, digits = 0) =>
  new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(value || 0);

export function Progress({ value, color = "bg-emerald-500" }: { value: number; color?: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div
        className={cn("h-full rounded-full transition-all", color)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Badge({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "green" | "amber" | "red" | "blue";
}) {
  const tones = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
    blue: "bg-blue-50 text-blue-700",
  };
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-medium", tones[tone])}>{children}</span>;
}
