import "server-only";
// Workforce service: plan (AI chooses and composes from registered skills; code validates), approve,
// and pause/resume individual employees. The plan is stored on the business record.
import { getAi } from "@/lib/ai";
import { AiError, describeAiError } from "@/lib/ai/errors";
import { ServiceError } from "@/lib/discovery/service";
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { audit } from "@/lib/integrations/connections";
import { buildWorkforce, WORKFORCE_SYSTEM, workforcePrompt, WorkforceProposalSchema, type WorkforceState } from "./plan";

export const MAX_REQUEST = 1_000;

function profileFacts(b: BusinessRecord): Record<string, string | null> {
  const f = b.profile?.fields ?? {};
  const pick = (k: string) => ((f as Record<string, { value: string | null } | undefined>)[k]?.value ?? null);
  return { business_name: b.name ?? pick("business_name"), industry: b.business_type ?? pick("industry"), products_services: pick("products_services"), customers_channels: pick("customers_channels"), challenges: pick("challenges"), goals: pick("goals"), current_tools: pick("current_tools") };
}

/** Plan a workforce from the owner's own words (and what discovery learned). Returns the stored plan. */
export async function planWorkforce(business: BusinessRecord, request: string): Promise<{ workforce: WorkforceState } | { aiError: { code: string; message: string } }> {
  const text = request.trim().slice(0, MAX_REQUEST);
  const profile = profileFacts(business);
  if (!text && !profile.goals && !profile.challenges) throw new ServiceError("VALIDATION_FAILED", 400, "Tell EmployAI what you'd like taken off your hands.");
  const ctx = { request: text, profile };
  let result;
  try {
    const ai = await getAi();
    result = await ai.structured({ task: "workforce_plan", schema: WorkforceProposalSchema, system: WORKFORCE_SYSTEM, user: workforcePrompt(ctx), context: ctx, maxTokens: 1400 });
  } catch (e) {
    const code = e instanceof AiError ? e.code : "UNKNOWN";
    return { aiError: { code, message: describeAiError(code as never) } };      // nothing is invented when AI fails
  }
  let workforce: WorkforceState;
  try { workforce = buildWorkforce(result.data, { request: text, plannedBy: { provider: result.provider, model: result.model, mode: result.mode } }); }
  catch { return { aiError: { code: "SCHEMA_INVALID", message: "The AI's plan didn't use any known skills, so it wasn't used. Try describing the work differently." } }; }
  await discoveryRepository().transact(business.id, s => {
    const b = s.businesses[business.id];
    if (!b) throw new ServiceError("NOT_FOUND", 404, "Not found.");
    b.workforce = workforce; b.updated_at = new Date().toISOString();
    audit(s, business.id, "owner", "workforce.planned", `business:${business.id}`, "proposed", business.id, { employees: workforce.employees.map(e => e.id), mode: workforce.planned_by.mode });
  });
  return { workforce };
}

export async function approveWorkforce(businessId: string): Promise<WorkforceState> {
  return discoveryRepository().transact(businessId, s => {
    const b = s.businesses[businessId];
    const wf = b?.workforce;
    if (!b || !wf) throw new ServiceError("STATE_CONFLICT", 409, "Plan a workforce first.");
    if (wf.status !== "approved") {
      wf.status = "approved"; wf.approved_at = new Date().toISOString();
      for (const e of wf.employees) if (e.status === "proposed") e.status = "active";
      audit(s, businessId, "owner", "workforce.approved", `business:${businessId}`, "approved", businessId, { employees: wf.employees.map(e => e.id) });
    }
    return wf;
  });
}

/** Pause or resume one employee. A paused employee's actions are refused at send time (authorise). */
export async function setEmployeeStatus(businessId: string, employeeId: string, status: "active" | "paused"): Promise<WorkforceState> {
  return discoveryRepository().transact(businessId, s => {
    const wf = s.businesses[businessId]?.workforce;
    const e = wf?.employees.find(x => x.id === employeeId);
    if (!wf || !e) throw new ServiceError("NOT_FOUND", 404, "That employee doesn't exist.");
    if (wf.status !== "approved") throw new ServiceError("STATE_CONFLICT", 409, "Approve the workforce first.");
    if (e.status !== status) { e.status = status; audit(s, businessId, "owner", status === "paused" ? "employee.paused" : "employee.resumed", `employee:${e.id}`, status, businessId); }
    return wf;
  });
}
