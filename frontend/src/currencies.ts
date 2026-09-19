/**
 * The currencies most people need for everyday personal finance.
 *
 * Keep the list short in create forms so the selector stays easy to scan.
 * Existing records can still keep any currency already stored in the account.
 */
export const COMMON_CURRENCIES = ["TWD", "USD", "JPY", "EUR"] as const;

export function currencyOptions(current?: string | null): string[] {
  return current && !COMMON_CURRENCIES.includes(current as (typeof COMMON_CURRENCIES)[number])
    ? [current, ...COMMON_CURRENCIES]
    : [...COMMON_CURRENCIES];
}
