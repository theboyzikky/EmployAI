"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Icon, ArrowCounterClockwiseIcon, ChartLineUpIcon, CircleNotchIcon, SkipForwardIcon, UsersThreeIcon, XIcon } from "@/components/icons";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import type { DiscoveryView } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";
import { AiModeBadge, AiUnavailable } from "./AiStatus";
import { AnalysisCard } from "./AnalysisCard";
import { ConsultantShell } from "./ConsultantShell";
import { ContextPanel } from "./ContextPanel";
import { ConsultantMessage, SystemNote, Thinking, UserMessage } from "./Messages";
import { MessageComposer } from "./MessageComposer";
import { SummaryReview } from "./SummaryReview";
import { TeamProposal, type AgentPatch } from "./TeamProposal";
import { callApi, type CallResult } from "./discovery-api";

type Busy = "thinking" | "analysing" | "saving" | "confirming" | "proposing" | "agent" | "approving" | null;
type Outbox = { content: string; clientId: string; failed: boolean } | null;

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * The AI business consultant workspace (stages 1–5). All state lives on the server; every action
 * returns the full view. The owner's message is saved before the AI is called, so failures and
 * timeouts never lose it; "Try again" asks for the reply without resending.
 */
export function DiscoveryWorkspace({ initialView }: { initialView: DiscoveryView }) {
  const [view, setView] = useState(initialView);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [aiError, setAiError] = useState<{ message: string; retry: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox>(null);
  const base = `/api/w/${view.id}`;
  const endRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    const r = await callApi(`${base}/discovery`, "GET");
    if (r.ok || r.view) setView(r.view!);
  }, [base]);

  const apply = useCallback((r: CallResult, retry: () => void): boolean => {
    if (r.view) setView(r.view);
    if (r.ok) { setAiError(null); setError(null); return true; }
    if (r.code === "AI_UNAVAILABLE") setAiError({ message: r.ai?.message ?? r.message, retry });
    else if (r.code === "TURN_IN_PROGRESS") { setError(r.message); setTimeout(() => { void refresh(); }, 3000); }
    else if (r.code === "CLIENT_TIMEOUT") { setAiError({ message: `${r.message} Your message is saved; the reply may still arrive.`, retry }); setTimeout(() => { void refresh(); }, 4000); }
    else setError(r.message);
    return false;
  }, [refresh]);

  const requestReply = useCallback(async () => {
    setBusy("thinking"); setAiError(null); setError(null);
    const r = await callApi(`${base}/discovery/messages`, "POST", {});
    setBusy(null);
    apply(r, () => { void requestReply(); });
  }, [apply, base]);

  // First visit after the hero hand-off: the consultant replies to the saved description.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialView.pendingReply) void requestReply();
  }, [initialView.pendingReply, requestReply]);

  const send = async (content: string, clientId = newId()) => {
    if (!content.trim() || busy) return;
    setOutbox({ content, clientId, failed: false });
    setInput(""); setBusy("thinking"); setAiError(null); setError(null);
    const r = await callApi(`${base}/discovery/messages`, "POST", { content, client_message_id: clientId });
    setBusy(null);
    const saved = r.ok || !!r.view?.messages.some(m => m.clientMessageId === clientId);
    setOutbox(saved ? null : { content, clientId, failed: true });
    apply(r, () => { void requestReply(); });
  };

  const skip = async () => {
    setBusy("thinking"); setAiError(null); setError(null);
    const r = await callApi(`${base}/discovery/messages`, "POST", { skip: true });
    setBusy(null);
    apply(r, () => { void requestReply(); });
  };

  const analyseNow = async () => {
    setBusy("analysing"); setAiError(null); setError(null);
    const r = await callApi(`${base}/discovery/analyse`, "POST", {});
    setBusy(null);
    apply(r, () => { void analyseNow(); });
  };

  const saveEdits = async (fields: Partial<Record<ProfileFieldKey, string | null>>) => {
    setBusy("saving");
    const r = await callApi(`${base}/discovery`, "PATCH", { fields });
    setBusy(null);
    return apply(r, () => undefined);
  };

  const propose = async () => {
    setBusy("proposing");
    const r = await callApi(`${base}/team/propose`, "POST", {});
    setBusy(null);
    return apply(r, () => { void propose(); });
  };

  const confirm = async (fields: Partial<Record<ProfileFieldKey, string | null>>) => {
    setBusy("confirming");
    const r = await callApi(`${base}/discovery/confirm`, "POST", Object.keys(fields).length ? { fields } : {});
    setBusy(null);
    if (!apply(r, () => undefined)) return false;
    return propose();
  };

  const patchAgent = async (key: AgentKey, patch: AgentPatch) => {
    setBusy("agent");
    const r = await callApi(`${base}/team/${key}`, "PATCH", patch);
    setBusy(null);
    return apply(r, () => undefined);
  };

  const approve = async () => {
    setBusy("approving");
    const r = await callApi(`${base}/team/approve`, "POST", {});
    setBusy(null);
    return apply(r, () => undefined);
  };

  // Keep the newest content in view (instant under reduced motion).
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" });
  }, [view.messages.length, outbox, busy === "thinking", reduced]);
  useEffect(() => {
    if (view.stage === "summary" || view.stage === "proposal") stageRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [view.stage, view.team?.proposed, reduced]);

  const conversationOpen = view.stage === "introduction" || view.stage === "discovery";
  const lastAssistant = [...view.messages].reverse().find(m => m.role === "assistant");
  const canSkip = conversationOpen && lastAssistant?.kind === "question" && !busy && !view.pendingReply;
  const lastAnalysisIndex = view.messages.map(m => m.kind).lastIndexOf("analysis");
  const showOutbox = outbox && !view.messages.some(m => m.clientMessageId === outbox.clientId);

  const stageBlocks = view.analysis && (
    <div ref={stageRef} className="scroll-mt-[150px] space-y-5">
      <AnalysisCard analysis={view.analysis} stale={view.analysisStale} onRefresh={() => { void analyseNow(); }} refreshing={busy === "analysing"} canRefresh={view.stage === "summary"} />
      <SummaryReview view={view} busy={busy} onSave={saveEdits} onConfirm={confirm} />
      {view.stage === "proposal" && !view.team?.proposed && (
        <div className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm text-muted">Your summary is confirmed. Ready to see the AI workforce I&rsquo;d recommend?</p>
          <button type="button" className="btn btn-primary btn-sm icon-host" onClick={() => { void propose(); }} disabled={!!busy}>
            {busy === "proposing" ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={UsersThreeIcon} size={16} />}
            Propose my team
          </button>
        </div>
      )}
      {view.team?.proposed && <TeamProposal team={view.team} busy={busy} onPatch={patchAgent} onApprove={approve} />}
    </div>
  );

  return (
    <ConsultantShell
      stage={view.stageIndex}
      complete={view.stage === "approved"}
      saved
      badge={<AiModeBadge ai={view.ai} />}
      panel={<ContextPanel fields={view.fields} />}
    >
      <h1 className="sr-only">Business discovery{view.businessName ? `: ${view.businessName}` : ""}</h1>
      <div className="flex flex-1 flex-col gap-5 pb-6">
        <ConsultantMessage>
          <p>Hi, I&rsquo;m your EmployAI business consultant. I&rsquo;ll learn how your business runs, analyse where automation could help, and propose an AI team for you to review.</p>
        </ConsultantMessage>

        {view.messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.role === "user"
              ? <UserMessage meta={m.kind === "description" ? "Your description" : undefined}>{m.content}</UserMessage>
              : <ConsultantMessage kind={(["question", "insight", "analysis", "note"].includes(m.kind) ? m.kind : "plain") as "question"}>{m.content}</ConsultantMessage>}
            {i === lastAnalysisIndex && stageBlocks}
          </Fragment>
        ))}

        {showOutbox && (
          <div>
            <UserMessage faded meta={outbox.failed ? <span className="text-danger">Not sent</span> : "Sending…"}>{outbox.content}</UserMessage>
            {outbox.failed && (
              <div className="mt-2 flex justify-end">
                <button type="button" className="btn btn-secondary btn-sm icon-host" onClick={() => { void send(outbox.content, outbox.clientId); }} disabled={!!busy}>
                  <Icon icon={ArrowCounterClockwiseIcon} size={16} /> Send again
                </button>
              </div>
            )}
          </div>
        )}

        {busy === "thinking" && <Thinking />}
        {busy === "analysing" && <Thinking label="Analysing how your business runs" />}
        {aiError && <AiUnavailable message={aiError.message} onRetry={aiError.retry} retrying={!!busy} />}

        {view.ready && view.stage === "discovery" && !busy && !aiError && (
          <div className="enter card flex flex-wrap items-center justify-between gap-3 border-accent-line px-5 py-4">
            <div>
              <p className="text-sm font-semibold text-ink">Ready for the analysis</p>
              <p className="text-sm font-light text-muted">I&rsquo;ll map your processes, bottlenecks and automation opportunities, then show you a summary to check.</p>
            </div>
            <button type="button" className="btn btn-primary btn-sm icon-host" onClick={() => { void analyseNow(); }}>
              <Icon icon={ChartLineUpIcon} size={16} /> Analyse my business
            </button>
          </div>
        )}
        <div ref={endRef} className="scroll-mb-36" aria-hidden="true" />
      </div>

      {/* The composer stays pinned while the conversation is open. Once discovery is complete the
          status note sits at the end of the page instead, so it never covers the analysis, summary
          or agent cards while the owner reads them. */}
      <div className={cx(
        conversationOpen
          ? "sticky bottom-0 -mx-4 border-t border-line bg-canvas/95 px-4 pb-4 pt-3 backdrop-blur sm:mx-0 sm:rounded-[var(--radius-card)] sm:border sm:bg-surface sm:px-4"
          : "mt-2",
      )}>
        {error && (
          <div role="alert" className="mb-2 flex items-start justify-between gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-ink">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss" className="icon-host inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:text-ink" onClick={() => setError(null)}>
              <Icon icon={XIcon} size={14} />
            </button>
          </div>
        )}
        {conversationOpen ? (
          <MessageComposer
            value={input}
            onChange={setInput}
            onSubmit={() => { void send(input.trim()); }}
            submitting={busy === "thinking"}
            submittingLabel="Sending your message"
            error={null}
            label="Your answer"
            placeholder={view.ready ? "Add anything else, or analyse your business above…" : "Answer in your own words…"}
            disabled={!!busy && busy !== "thinking"}
            disabledReason={view.limits.ownerMessagesLeft <= 5 ? `${view.limits.ownerMessagesLeft} messages left in this conversation.` : undefined}
            autoFocus={!initialView.pendingReply}
            extra={canSkip ? (
              <button type="button" onClick={() => { void skip(); }} className="icon-host inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-muted hover:text-accent">
                <Icon icon={SkipForwardIcon} size={14} /> Skip this question
              </button>
            ) : undefined}
          />
        ) : (
          <SystemNote>
            {view.stage === "approved"
              ? "Discovery is complete and your team is approved. Nothing runs until workflows are built and approved in the next stage."
              : "Discovery is complete. Correct anything in the summary above; your changes are saved."}
          </SystemNote>
        )}
      </div>
    </ConsultantShell>
  );
}
