const taipeiDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function taipeiDateInputValue(date = new Date()) {
  const parts = Object.fromEntries(
    taipeiDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function taipeiMonthInputValue(date = new Date()) {
  return taipeiDateInputValue(date).slice(0, 7);
}

export function daysBetweenDateValues(from?: string | null, to = taipeiDateInputValue()) {
  if (!from) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}
