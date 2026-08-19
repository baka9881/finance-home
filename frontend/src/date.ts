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
