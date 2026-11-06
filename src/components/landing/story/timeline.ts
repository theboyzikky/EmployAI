// Scroll-driven "film" timeline. `p` is the scroll position through the pinned stage:
// p < 0 is the lead-in while the stage scrolls into view, 0 → 1 is the pinned range.
// Each element has its own keyframes, so elements start, move and settle at different moments
// and speeds (nothing moves all at once). Coordinates are design pixels relative to the centre
// of a fixed design canvas, which is scaled to fit the available space.

export type Values = { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number; o: number; b: number };
export type Keyframe = Partial<Values> & { at: number };
type Frame = Values & { at: number };

const DEFAULT: Values = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, o: 1, b: 0 };
const KEYS = Object.keys(DEFAULT) as Array<keyof Values>;

/** Missing values carry forward from the previous keyframe. */
function resolve(kfs: Keyframe[]): Frame[] {
  let prev: Frame = { ...DEFAULT, at: kfs[0]?.at ?? 0 };
  return kfs.map(k => (prev = { ...prev, ...k }));
}

// Smooth, unhurried ease (no overshoot, no bounce).
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function sample(frames: Frame[], p: number): Values {
  if (p <= frames[0].at) return frames[0];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (p < b.at) {
      const t = ease((p - a.at) / (b.at - a.at || 1));
      const out = {} as Values;
      for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
      return out;
    }
  }
  return frames[frames.length - 1];
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const range = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));

// ---------------------------------------------------------------------------------------------
// Story beats (shared by both layouts)
// ---------------------------------------------------------------------------------------------
export const LEAD_IN = -0.24;
/** Scene windows for captions and the progress indicator. Index 4 is the finale (part of scene 4). */
export const CAPTION_WINDOWS: Array<[number, number]> = [[-9, 0.17], [0.17, 0.4], [0.4, 0.64], [0.64, 0.9], [0.9, 9]];
export const PROGRESS_WINDOWS: Array<[number, number]> = [[0, 0.17], [0.17, 0.4], [0.4, 0.64], [0.64, 1]];
export const STEP_START = 0.735;
export const STEP_GAP = 0.027;
export const FINALE_AT = 0.93;

export type ElKey = "biz" | "op0" | "op1" | "op2" | "op3" | "ag0" | "ag1" | "ag2" | "ag3" | "ag4" | "panel" | "ring";
export type LineDef = { from: ElKey; to: ElKey; draw: [number, number]; fade?: [number, number] };

export const LINES: LineDef[] = [
  // Scene 2: the business connects to each operation.
  ...[0, 1, 2, 3].map(i => ({ from: "biz" as ElKey, to: `op${i}` as ElKey, draw: [0.27 + i * 0.012, 0.33 + i * 0.012] as [number, number], fade: [0.39, 0.44] as [number, number] })),
  // Scene 3: the orchestrator connects to each specialist.
  ...[1, 2, 3, 4].map(i => ({ from: "ag0" as ElKey, to: `ag${i}` as ElKey, draw: [0.55 + i * 0.01, 0.61 + i * 0.01] as [number, number], fade: [0.63, 0.67] as [number, number] })),
  // Finale: the business at the centre of its workforce.
  ...[0, 1, 2, 3, 4].map(i => ({ from: "biz" as ElKey, to: `ag${i}` as ElKey, draw: [0.92 + i * 0.008, 0.975 + i * 0.008] as [number, number] })),
];

// The ring sits far behind every card (z −700) so tilted cards never intersect its plane;
// the scale compensates for the perspective shrink (1300 / 2000).
const RING: Keyframe[] = [
  { at: 0.9, z: -700, s: 0.92, o: 0 },
  { at: 0.97, z: -700, s: 1.54, o: 1 },
];

export type Layout = { name: "wide" | "narrow"; w: number; h: number; tracks: Record<ElKey, Frame[]> };

type XY = [number, number];

function opTrack(i: number, origin: XY, pos: XY, rz: number, s: number, z: number): Keyframe[] {
  const t = 0.19 + i * 0.025;
  return [
    { at: t, x: origin[0], y: origin[1], z: -220, s: 0.5 * s, rz: 0, o: 0 },
    { at: t + 0.075, x: pos[0], y: pos[1], z, rz, s, o: 1 },
    { at: 0.41 + i * 0.012 },
    { at: 0.49 + i * 0.012, x: pos[0] * 1.3, y: pos[1] * 1.2, z: -320, rz: rz * 2, o: 0, b: 3 },
  ];
}

type Pose = Partial<Values>;
type AgentPlan = { from: Pose; team: XY; rz: number; scene4: Pose; finale: XY; finaleS: number };

function agentTrack(i: number, a: AgentPlan): Keyframe[] {
  const t = i === 0 ? 0.43 : 0.455 + (i - 1) * 0.02;
  const t4 = 0.64 + i * 0.012;
  const tf = 0.9 + i * 0.008;
  return [
    { ...a.from, at: t, o: 0 },
    { at: t + 0.075, x: a.team[0], y: a.team[1], z: i === 0 ? 40 : 0, rx: 0, ry: 0, rz: a.rz, s: 1, o: 1, b: 0 },
    { at: t4 },
    { ...a.scene4, at: t4 + 0.07 },
    { at: tf },
    { at: tf + 0.06, x: a.finale[0], y: a.finale[1], z: 0, rx: 0, ry: 0, rz: 0, s: a.finaleS, o: 1, b: 0 },
  ];
}

function build(name: Layout["name"], w: number, h: number, t: Record<ElKey, Keyframe[]>): Layout {
  const tracks = {} as Record<ElKey, Frame[]>;
  for (const k of Object.keys(t) as ElKey[]) tracks[k] = resolve(t[k]);
  return { name, w, h, tracks };
}

// ---------------------------------------------------------------------------------------------
// Wide layout: 760 × 600 design canvas (tablet and desktop)
// ---------------------------------------------------------------------------------------------
const W_OPS: Array<{ pos: XY; rz: number; s: number; z: number }> = [
  { pos: [-258, -148], rz: -4, s: 1, z: 0 },
  { pos: [264, -120], rz: 3, s: 0.92, z: -50 },
  { pos: [-240, 150], rz: 3, s: 1.06, z: 30 },
  { pos: [252, 166], rz: -3, s: 0.96, z: -20 },
];
const W_AGENTS: AgentPlan[] = [
  { from: { x: 0, y: 40, z: -520, rx: 24, ry: 0, rz: 0, s: 0.9 }, team: [0, -4], rz: 0, scene4: { x: -259, y: -212, z: 0, rz: 0, s: 0.76 }, finale: [0, -218], finaleS: 0.72 },
  { from: { x: -560, y: -280, z: -200, ry: 30, rz: -10, s: 0.9 }, team: [-252, -140], rz: -2, scene4: { x: -272, y: -104, z: 0, rz: 0, s: 0.76 }, finale: [-282, -70], finaleS: 0.72 },
  { from: { x: 560, y: -260, z: -200, ry: -30, rz: 9, s: 0.9 }, team: [254, -126], rz: 2, scene4: { x: -272, y: 0, z: 0, rz: 0, s: 0.76 }, finale: [282, -70], finaleS: 0.72 },
  { from: { x: -560, y: 320, z: -200, ry: 28, rz: 8, s: 0.9 }, team: [-248, 142], rz: 2, scene4: { x: -272, y: 104, z: 0, rz: 0, s: 0.76 }, finale: [-215, 175], finaleS: 0.72 },
  { from: { x: 560, y: 320, z: -200, ry: -28, rz: -8, s: 0.9 }, team: [250, 152], rz: -2, scene4: { x: -272, y: 208, z: 0, rz: 0, s: 0.76 }, finale: [215, 175], finaleS: 0.72 },
];

export const WIDE = build("wide", 760, 600, {
  biz: [
    { at: LEAD_IN, x: 0, y: 80, z: -520, rx: 28, ry: -18, rz: -4, s: 0.9, o: 0 },
    { at: 0.04, y: 0, z: 0, rx: 6, ry: -6, rz: -1, s: 1, o: 1 },
    { at: 0.16, rx: 0, ry: 0, rz: 0 },
    { at: 0.25, y: -6, z: -40, s: 0.84 },
    { at: 0.41 },
    { at: 0.52, z: -380, rx: 12, s: 0.8, o: 0.3, b: 2 },
    { at: 0.66, o: 0.14 },
    { at: 0.72, z: -500, o: 0 },
    { at: 0.9, y: 24, rx: 10, s: 0.8 },
    { at: 0.96, y: 0, z: 0, rx: 0, s: 0.74, o: 1, b: 0 },
  ],
  ...Object.fromEntries(W_OPS.map((o, i) => [`op${i}`, opTrack(i, [0, -6], o.pos, o.rz, o.s, o.z)])),
  ...Object.fromEntries(W_AGENTS.map((a, i) => [`ag${i}`, agentTrack(i, a)])),
  panel: [
    { at: 0.66, x: 330, y: 10, z: -300, ry: -24, s: 0.9, o: 0 },
    { at: 0.735, x: 118, y: 0, z: 0, ry: 0, s: 1, o: 1 },
    { at: 0.9 },
    { at: 0.96, x: 0, z: -460, s: 0.92, o: 0.16, b: 2 },
  ],
  ring: RING,
} as Record<ElKey, Keyframe[]>);

// ---------------------------------------------------------------------------------------------
// Narrow layout: 360 × 560 design canvas (phones). Same story, simpler composition.
// ---------------------------------------------------------------------------------------------
const N_OPS: Array<{ pos: XY; rz: number; s: number; z: number }> = [
  { pos: [-84, 40], rz: -3, s: 0.96, z: 0 },
  { pos: [86, 54], rz: 3, s: 1, z: -30 },
  { pos: [-80, 166], rz: 2, s: 0.94, z: 20 },
  { pos: [84, 180], rz: -2, s: 1, z: -10 },
];
const recede = (x: number, y: number): Pose => ({ x: x * 1.15, y: y * 1.1, z: -260, rz: 0, s: 0.9, o: 0, b: 2 });
const N_AGENTS: AgentPlan[] = [
  { from: { x: 0, y: -120, z: -520, rx: 24, ry: 0, rz: 0, s: 0.9 }, team: [0, -176], rz: 0, scene4: recede(0, -176), finale: [0, -196], finaleS: 0.6 },
  { from: { x: -380, y: -60, z: -200, ry: 30, rz: -10, s: 0.9 }, team: [-90, -28], rz: -2, scene4: recede(-90, -28), finale: [-112, -118], finaleS: 0.56 },
  { from: { x: 380, y: -40, z: -200, ry: -30, rz: 9, s: 0.9 }, team: [90, -14], rz: 2, scene4: recede(90, -14), finale: [112, -118], finaleS: 0.56 },
  { from: { x: -380, y: 220, z: -200, ry: 28, rz: 8, s: 0.9 }, team: [-90, 118], rz: 2, scene4: recede(-90, 118), finale: [-112, 128], finaleS: 0.56 },
  { from: { x: 380, y: 240, z: -200, ry: -28, rz: -8, s: 0.9 }, team: [90, 132], rz: -2, scene4: recede(90, 132), finale: [112, 128], finaleS: 0.56 },
];

export const NARROW = build("narrow", 360, 560, {
  biz: [
    { at: LEAD_IN, x: 0, y: 70, z: -480, rx: 26, ry: -14, rz: -4, s: 0.9, o: 0 },
    { at: 0.04, y: 0, z: 0, rx: 6, ry: -4, rz: -1, s: 1, o: 1 },
    { at: 0.16, rx: 0, ry: 0, rz: 0 },
    { at: 0.25, y: -150, s: 0.8 },
    { at: 0.41 },
    { at: 0.52, y: -170, z: -360, rx: 12, s: 0.76, o: 0.25, b: 2 },
    { at: 0.66, o: 0.1 },
    { at: 0.72, z: -480, o: 0 },
    { at: 0.9, y: 10, rx: 10, s: 0.7 },
    { at: 0.96, y: 0, z: 0, rx: 0, s: 0.64, o: 1, b: 0 },
  ],
  ...Object.fromEntries(N_OPS.map((o, i) => [`op${i}`, opTrack(i, [0, -150], o.pos, o.rz, o.s, o.z)])),
  ...Object.fromEntries(N_AGENTS.map((a, i) => [`ag${i}`, agentTrack(i, a)])),
  panel: [
    { at: 0.66, x: 0, y: 120, z: -300, rx: 18, s: 0.92, o: 0 },
    { at: 0.735, y: 0, z: 0, rx: 0, s: 1, o: 1 },
    { at: 0.9 },
    { at: 0.96, z: -460, s: 0.92, o: 0.12, b: 2 },
  ],
  ring: RING,
} as Record<ElKey, Keyframe[]>);

export const ELEMENT_KEYS = Object.keys(WIDE.tracks) as ElKey[];
