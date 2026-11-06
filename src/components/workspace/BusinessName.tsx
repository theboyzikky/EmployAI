"use client";

import { useEffect, useState } from "react";
import type { WorkspaceView } from "@/lib/workflows/view-types";

/**
 * The business name in the workspace header. Discovery identifies the name, and the owner can come
 * back to this page with the browser's Back button, which restores the page from the client cache.
 * So while no name is known, the name is re-checked each time this header is shown (and when the tab
 * becomes visible again). Once a name is known no further requests are made.
 */
export function BusinessName({ businessId, initial }: { businessId: string; initial: string | null }) {
  const [name, setName] = useState(initial);

  useEffect(() => { if (initial) setName(initial); }, [initial]);

  useEffect(() => {
    if (name) return;
    let live = true;
    const check = async () => {
      try {
        const res = await fetch(`/api/w/${businessId}/workflows`, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { view?: WorkspaceView } | null;
        if (live && json?.view?.businessName) setName(json.view.businessName);
      } catch { /* keep the placeholder; the next visit tries again */ }
    };
    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { live = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [businessId, name]);

  return name
    ? <p className="hidden truncate text-sm font-semibold text-ink sm:block" title={name}>{name}</p>
    : <p className="hidden truncate text-sm font-medium text-muted sm:block">Business name not identified yet</p>;
}
