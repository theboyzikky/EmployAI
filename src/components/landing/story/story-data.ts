import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  PackageIcon, ReceiptIcon, ShieldCheckIcon, StorefrontIcon, TreeStructureIcon, TruckIcon, WalletIcon,
} from "@/components/icons";

// Content for the "Watch your business come to life" film. Everything here is an ILLUSTRATION of the
// fictional demo restaurant: no live data, no real orders, payments or integrations.

export const BUSINESS = {
  icon: StorefrontIcon,
  name: "Harbour Street Kitchen",
  industry: "Restaurant",
  details: [
    { label: "Orders", value: "Counter, WhatsApp" },
    { label: "Menu", value: "24 dishes" },
    { label: "Suppliers", value: "3 local" },
    { label: "Pain point", value: "Rice runs out" },
  ],
} as const;

export type Operation = { icon: PhosphorIcon; title: string; detail: string };
export const OPERATIONS: Operation[] = [
  { icon: ReceiptIcon, title: "Orders", detail: "Counter + WhatsApp" },
  { icon: PackageIcon, title: "Inventory", detail: "Rice below reorder point" },
  { icon: TruckIcon, title: "Procurement", detail: "3 approved suppliers" },
  { icon: WalletIcon, title: "Finance", detail: "Daily spending limit" },
];

export type StoryAgent = {
  icon: PhosphorIcon;
  name: string;
  role: string;
  /** Small identity indicator: a label and a five-bar signature unique to the agent. */
  signal: string;
  bars: [number, number, number, number, number];
};
export const AGENTS: StoryAgent[] = [
  { icon: TreeStructureIcon, name: "Business Orchestrator", role: "Coordinates the team", signal: "Coordinating", bars: [0.5, 0.8, 1, 0.8, 0.5] },
  { icon: ReceiptIcon, name: "Order Agent", role: "Checks every order", signal: "Orders", bars: [0.4, 0.7, 0.55, 0.9, 0.65] },
  { icon: PackageIcon, name: "Inventory Agent", role: "Tracks stock levels", signal: "Stock", bars: [1, 0.85, 0.6, 0.4, 0.25] },
  { icon: TruckIcon, name: "Procurement Agent", role: "Sources from suppliers", signal: "Quotes", bars: [0.6, 0.6, 0.95, 0.6, 0.6] },
  { icon: WalletIcon, name: "Finance Agent", role: "Prepares payments", signal: "Budget", bars: [0.3, 0.45, 0.6, 0.75, 0.9] },
];

export type StoryStep = { icon: PhosphorIcon; by: string; title: string; detail: string; agent: number | null };
/** `agent` is the index in AGENTS that performs the step (null = deterministic security layer). */
export const STEPS: StoryStep[] = [
  { icon: ReceiptIcon, by: "Order Agent", title: "Customer order received", detail: "2 × rice bowl · counter", agent: 1 },
  { icon: PackageIcon, by: "Inventory Agent", title: "Availability checked", detail: "Rice below reorder point", agent: 2 },
  { icon: TruckIcon, by: "Procurement Agent", title: "Shortage handled", detail: "Best of 3 approved suppliers", agent: 3 },
  { icon: WalletIcon, by: "Finance Agent", title: "Payment request prepared", detail: "Supplier invoice · within budget", agent: 4 },
  { icon: ShieldCheckIcon, by: "Security layer", title: "Transaction evaluated", detail: "Recipient, limits and policy checked", agent: null },
];

export const DECISIONS = ["ALLOW", "WARN", "BLOCK"] as const;

export type Scene = { label: string; title: string; body: string };
export const SCENES: Scene[] = [
  { label: "Your business", title: "It starts with how you work.", body: "EmployAI learns the restaurant: what it sells, how customers order and where time is lost." },
  { label: "Understanding your operations", title: "Every part of the business, connected.", body: "Orders, stock, suppliers and money are mapped, along with how each one affects the others." },
  { label: "Your AI workforce", title: "A team built around those operations.", body: "Five specialised agents, each with one clear job, coordinated by the Business Orchestrator." },
  { label: "Work gets done", title: "One order, handled end to end.", body: "Agents hand work to each other, and every payment passes the security layer before anything moves." },
];
export const FINALE: Scene = {
  label: "Work gets done",
  title: "Your business, coordinated.",
  body: "The AI workforce keeps everyday operations connected, while you stay in control of every rule.",
};
