"use client";

import { useState } from "react";
import { MessageComposer } from "./MessageComposer";
import { useStartConversation } from "./useStartConversation";

/** Composer for a fresh conversation ("Get started" without a hero message). */
export function StartComposer() {
  const [value, setValue] = useState("");
  const { submit, status, error, clearError } = useStartConversation();
  return (
    <MessageComposer
      value={value}
      onChange={v => { setValue(v); if (error) clearError(); }}
      onSubmit={() => submit(value)}
      submitting={status === "submitting"}
      error={error}
      label="Describe your business"
      placeholder="I run a business that…"
      autoFocus
    />
  );
}
