import { useLayoutEffect } from "react";

/** Restore only after the matching page exists; never save a loading skeleton's position. */
export function useTransactionScroll(scope: string, ready: boolean) {
  useLayoutEffect(() => {
    if (!ready) return;
    const key = `finance.transaction-scroll.${scope}`;
    let top = 0;
    try { top = Math.max(0, Number(sessionStorage.getItem(key)) || 0); } catch { /* unavailable */ }
    const save = () => { try { sessionStorage.setItem(key, String(window.scrollY)); } catch { /* unavailable */ } };
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top, behavior: "instant" });
      window.addEventListener("scroll", save, { passive: true });
    });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", save); };
  }, [scope, ready]);
}
