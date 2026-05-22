"use client";

import { useEffect } from "react";

/**
 * Prompt the browser before refresh/close when the user has unpublished work.
 * Modern browsers show a generic confirmation; custom text is ignored but
 * `preventDefault` + `returnValue` must be set to trigger the dialog.
 */
export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
