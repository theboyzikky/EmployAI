"use client";

import { useRef, useState } from "react";
import { Icon, BriefcaseIcon, ForkKnifeIcon, ShieldCheckIcon, ShoppingCartIcon, SparkleIcon } from "@/components/icons";
import { MessageComposer } from "@/components/onboarding/MessageComposer";
import { useStartConversation } from "@/components/onboarding/useStartConversation";

const EXAMPLES = [
  { label: "Restaurant", icon: ForkKnifeIcon, text: "I run a small restaurant. We take orders at the counter and on WhatsApp, and we often run out of rice and cooking oil because I reorder from suppliers by phone." },
  { label: "Online store", icon: ShoppingCartIcon, text: "I sell handmade skincare products online. I want help tracking stock, answering order questions and reordering packaging before we run out." },
  { label: "Service business", icon: BriefcaseIcon, text: "I run a hair salon with four stylists. Clients book by phone and WhatsApp, and no-shows and double bookings cost us time and money." },
] as const;

/**
 * The hero's conversational entry point. Optional: the page works fully without it.
 * Submitting creates a discovery session and continues in the consultant view with the same text.
 */
export function HeroChat() {
  const [value, setValue] = useState("");
  const { submit, status, error, clearError } = useStartConversation();
  const inputId = "hero-business-description";
  const wrapRef = useRef<HTMLDivElement>(null);

  const applyExample = (text: string) => {
    setValue(text);
    clearError();
    // Chips populate the input; they never submit on their own. Focus moves to the input so the
    // visitor can edit straight away (caret placed at the end once React has applied the value).
    const el = document.getElementById(inputId) as HTMLTextAreaElement | null;
    el?.focus();
    setTimeout(() => el?.setSelectionRange(text.length, text.length), 0);
  };

  return (
    <div ref={wrapRef} id="describe" className="card enter rounded-[var(--radius-panel)] p-4 text-left sm:p-6" style={{ ["--enter-delay" as string]: "360ms" }}>
      <div className="flex items-start gap-3 sm:gap-4">
        <span className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent-solid text-on-accent shadow-[0_8px_20px_-8px_var(--eai-glow-strong)]">
          <Icon icon={SparkleIcon} size={22} swap={false} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[1.0625rem] font-semibold text-ink">Let&rsquo;s get to know your business</p>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted" title="Your description is saved securely and your conversation continues on the next screen.">
              <span className="status-dot h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              Ready
            </span>
          </div>
          <p className="mt-2 inline-block rounded-2xl rounded-tl-md bg-accent-soft px-3.5 py-2.5 text-[0.9375rem] font-light leading-relaxed text-ink/85">
            Tell me what your business does and what you&rsquo;d like to automate. I&rsquo;ll help you design the right AI workforce.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <MessageComposer
          inputId={inputId}
          value={value}
          onChange={v => { setValue(v); if (error) clearError(); }}
          onSubmit={() => submit(value)}
          submitting={status === "submitting"}
          error={error}
          label="Describe your business"
          placeholder="I run a business that…"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Example businesses">
        <span className="mr-1 text-xs font-medium text-muted">Try an example:</span>
        {EXAMPLES.map(ex => (
          <button key={ex.label} type="button" className="chip icon-host" onClick={() => applyExample(ex.text)}>
            <Icon icon={ex.icon} size={17} />
            {ex.label}
          </button>
        ))}
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-muted">
        <Icon icon={ShieldCheckIcon} size={15} swap={false} className="text-accent" />
        No technical knowledge required
      </p>
    </div>
  );
}
