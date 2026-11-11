// Durable task records of the automation engine (layer C), one business partition each.
// Type-only module (shared with the store and the migration script).

export type TaskKind = "advance_run" | "process_event" | "drive_action" | "poll_mailbox";
export type TaskStatus = "queued" | "running" | "done" | "dead" | "cancelled";

export type TaskRecord = {
  id: string;
  business_id: string;
  kind: TaskKind;
  /** What the task works on: a run id, an inbound event id or an action attempt id. */
  ref: string;
  /** At most one live (queued/running) task per dedupe key. */
  dedupe_key: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  /** Not before this time (retries back off). */
  next_at: string;
  /** A running task's lease; an expired lease means its worker died and the task can be reclaimed. */
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
