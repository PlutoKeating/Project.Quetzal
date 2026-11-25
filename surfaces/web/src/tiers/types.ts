import type { Density, ProjectedRow } from "../model/state.js";

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ToolCardState {
  kind: "tool" | "approval" | "error";
  id: string;
  title: string;
  detail?: string;
}

export interface TierActions {
  toggleSelection(key: string): void;
  copyReference(key: string): void;
  resolveApproval(id: string): void;
  retryConnection(): void;
  retryMessage(): void;
}

export interface TierContext {
  density: Density;
  rev: number;
  rows: readonly ProjectedRow[];
  transcript: readonly TranscriptItem[];
  cards: readonly ToolCardState[];
  selection: ReadonlySet<string>;
  online: boolean;
  offlineDetail: string;
  rawSnapshot: string;
  actions: TierActions;
}
