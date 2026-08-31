import { useEffect, useState } from "react";

export type OwnerFilter = "all" | "me" | "partner" | "shared";

const storageKey = "finance:ownerFilter";
const selectableOwners = new Set<OwnerFilter>(["all", "me", "partner"]);
const changeEventName = "finance:ownerFilterChanged";

export const ownerFilterOptions = [
  { value: "all", label: "全部" },
  { value: "me", label: "我" },
  { value: "partner", label: "小居" },
] as const;

export const ownerFilterLabels: Record<OwnerFilter, string> = {
  all: "全部",
  me: "我",
  partner: "小居",
  shared: "共同",
};

function readStoredOwnerFilter(fallback: OwnerFilter): OwnerFilter {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return selectableOwners.has(stored as OwnerFilter) ? (stored as OwnerFilter) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredOwnerFilter(value: OwnerFilter) {
  try {
    window.localStorage.setItem(storageKey, value);
    window.dispatchEvent(new CustomEvent(changeEventName, { detail: value }));
  } catch {
    // Local storage can fail in restricted browser modes. The in-page state still works.
  }
}

export function useOwnerFilter(fallback: OwnerFilter = "all") {
  const [ownerFilter, setOwnerFilterState] = useState<OwnerFilter>(() => readStoredOwnerFilter(fallback));

  useEffect(() => {
    function handleOwnerFilterChange(event: Event) {
      const next = (event as CustomEvent<OwnerFilter>).detail;
      if (selectableOwners.has(next)) {
        setOwnerFilterState(next);
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== storageKey) return;
      setOwnerFilterState(readStoredOwnerFilter(fallback));
    }

    window.addEventListener(changeEventName, handleOwnerFilterChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(changeEventName, handleOwnerFilterChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, [fallback]);

  function setOwnerFilter(value: string) {
    const next = selectableOwners.has(value as OwnerFilter) ? (value as OwnerFilter) : fallback;
    setOwnerFilterState(next);
    writeStoredOwnerFilter(next);
  }

  return [ownerFilter, setOwnerFilter] as const;
}
