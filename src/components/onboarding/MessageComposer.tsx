"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, CircleNotchIcon, PaperPlaneTiltIcon, WarningIcon } from "@/components/icons";
import { MAX_MESSAGE_LENGTH } from "@/lib/discovery/message";
import { cx } from "@/lib/cx";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  label: string;
  placeholder: string;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  inputId?: string;
  /** Accessible name of the send button while submitting. */
  submittingLabel?: string;
  /** Extra controls under the input (e.g. "Skip this question"). */
  extra?: ReactNode;
};

/** Auto-growing message box: Enter sends, Shift+Enter adds a line. Send is disabled when empty. */
export function MessageComposer({ value, onChange, onSubmit, submitting, error, label, placeholder, disabled, disabledReason, autoFocus, inputId, submittingLabel = "Starting your conversation", extra }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [focused, setFocused] = useState(false);
  const empty = value.trim().length === 0;
  const canSend = !empty && !submitting && !disabled;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <form
      onSubmit={e => { e.preventDefault(); if (canSend) onSubmit(); }}
      aria-busy={submitting}
      className="w-full"
    >
      <label htmlFor={id} className="sr-only">{label}</label>
      <div
        className={cx(
          "flex items-end gap-2 rounded-[var(--radius-input)] border bg-surface p-2 pl-4 transition-[border-color,box-shadow] duration-200",
          error ? "border-danger" : focused ? "border-accent shadow-[0_0_0_4px_var(--eai-glow)]" : "border-line",
          disabled && "bg-surface-2",
        )}
      >
        <textarea
          ref={ref}
          id={id}
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          disabled={disabled || submitting}
          aria-invalid={error ? true : undefined}
          aria-describedby={cx(error && errorId, (disabledReason || value.length > MAX_MESSAGE_LENGTH * 0.9) && hintId) || undefined}
          className="min-h-[44px] flex-1 resize-none bg-transparent py-2.5 text-[1rem] leading-6 text-ink outline-none placeholder:font-light placeholder:text-subtle disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={submitting ? submittingLabel : "Send"}
          className={cx(
            "icon-host inline-flex h-11 w-11 flex-none items-center justify-center rounded-[12px] transition-[background-color,color,transform] duration-200",
            canSend ? "bg-ink text-on-ink hover:bg-accent-solid hover:text-on-accent active:scale-95" : "bg-surface-2 text-subtle ring-1 ring-line",
          )}
        >
          {submitting ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={20} swap={false} /></span> : <Icon icon={PaperPlaneTiltIcon} size={20} />}
        </button>
      </div>
      <div className="flex min-h-5 flex-wrap items-start justify-between gap-2 pt-1.5" aria-live="polite">
        <div>
        {error ? (
          <p id={errorId} role="alert" className="flex items-center gap-1.5 text-sm font-medium text-danger">
            <Icon icon={WarningIcon} size={16} swap={false} /> {error}
          </p>
        ) : disabledReason ? (
          <p id={hintId} className="text-sm font-light text-muted">{disabledReason}</p>
        ) : value.length > MAX_MESSAGE_LENGTH * 0.9 ? (
          <p id={hintId} className="text-xs font-light text-muted">{value.length} / {MAX_MESSAGE_LENGTH} characters</p>
        ) : null}
        </div>
        {extra}
      </div>
    </form>
  );
}
