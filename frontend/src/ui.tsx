import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { twMerge } from "tailwind-merge";

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

export function MonthInput({
  className,
  value,
  disabled,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const rawValue = typeof value === "string" ? value : "";
  const [year, month] = rawValue.split("-");
  const displayValue = year && month
    ? `${year}年${Number(month)}月`
    : "選擇月份";

  return (
    <label
      className={cn(
        "relative flex h-11 min-w-0 w-full max-w-full cursor-pointer items-center overflow-hidden rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-500/10",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{displayValue}</span>
      <CalendarDays className="ml-3 shrink-0 text-slate-500" size={16} aria-hidden="true" />
      <input
        className="absolute inset-0 h-full min-h-0 w-full min-w-0 max-w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        type="month"
        value={value}
        disabled={disabled}
        aria-label={props["aria-label"] || "選擇月份"}
        {...props}
      />
    </label>
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
    <label className="block space-y-2">
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
    <section className="space-y-4 rounded-2xl border border-slate-200 p-4 sm:p-5">
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
  if (!open) return null;
  const widths = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-5xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:p-4">
      <div className={cn("flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden rounded-none bg-white shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-3xl", widths[size])}>
        <div className="z-10 flex shrink-0 items-start justify-between border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:px-6 sm:py-5">
          <div>
            <h2 className="text-xl font-bold text-ink">{title}</h2>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
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
}: {
  current: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onCancel: () => void;
  submitLabel: string;
  pending?: boolean;
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
          <Button type="submit" className="flex-1" disabled={pending}>{submitLabel}</Button>
        )}
      </div>
      <div className="hidden justify-end gap-3 pt-2 sm:flex">
        <Button type="button" variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={pending}>{submitLabel}</Button>
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
