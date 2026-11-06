// Test helper: an offline discovery conversation driven exactly as the service drives it
// (offline interpretation → code-owned turn), without HTTP or storage.
import { emptyCaseFile, type CaseFile } from "@/lib/discovery/casefile";
import { emptyProfile, type ProfileDoc } from "@/lib/discovery/profile";
import { legacyBookkeeping, runTurn, type TurnResult } from "@/lib/discovery/reasoning";
import { offlineDiscoveryTurn } from "@/lib/rules/consultant";

export type Exchange = { owner: string; reply: string; turn: TurnResult };

export function conversation(start?: ProfileDoc) {
  let profile: ProfileDoc = start ?? { ...emptyProfile(), case_file: emptyCaseFile("native") };
  const transcript: Array<{ id: string; role: "user" | "assistant"; content: string }> = [];
  const log: Exchange[] = [];
  let n = 0;
  const say = (text: string): Exchange => {
    const id = `m${++n}`;
    transcript.push({ id, role: "user", content: text });
    const firstTurn = !transcript.some(m => m.role === "assistant");
    const cf = profile.case_file as CaseFile;
    const offline = offlineDiscoveryTurn({ profile, caseFile: cf, transcript, newOwnerMessageIds: [id], firstTurn });
    const owner = new Set(transcript.filter(m => m.role === "user").map(m => m.id));
    const turn = runTurn(profile, cf, offline.interpretation, owner, { firstTurn });
    profile = { ...profile, case_file: turn.caseFile, fields: turn.fields, ...legacyBookkeeping(turn.caseFile), stage: "discovery" };
    transcript.push({ id: `a${n}`, role: "assistant", content: turn.reply });
    const ex = { owner: text, reply: turn.reply, turn };
    log.push(ex);
    return ex;
  };
  /** Make `kind:target` the question waiting for an answer (to reproduce "this reply answered that question"). */
  const pend = (kind: "fact", target: string) => {
    const cf = structuredClone(profile.case_file as CaseFile);
    const key = `${kind}:${target}`;
    let item = cf.agenda.find(a => a.key === key);
    if (!item) { item = { key, kind, target, problem_id: null, asked: 0, status: "open" }; cf.agenda.push(item); }
    item.asked += 1; item.status = "open"; cf.pending = key; cf.questions_asked += 1;
    profile = { ...profile, case_file: cf, ...legacyBookkeeping(cf) };
  };
  return { say, pend, log, get profile() { return profile; }, get caseFile() { return profile.case_file as CaseFile; }, transcript };
}
