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

export interface SessionInfo {
  kind: "personal" | "group";
  roomId: string | null;
  detail: string;
}

export interface OnboardingState {
  step: number;
  total: number;
}

export interface TierActions {
  toggleSelection(key: string): void;
  copyReference(key: string): void;
  resolveApproval(id: string): void;
  retryConnection(): void;
  retryMessage(): void;
  commitArtifact(key: string): void;
  skipOnboarding(): void;
}

export interface TierContext {
  density: Density;
  rev: number;
  rows: readonly ProjectedRow[];
  transcript: readonly TranscriptItem[];
  cards: readonly ToolCardState[];
  selection: ReadonlySet<string>;
  online: boolean;
  starting: boolean;
  offlineDetail: string;
  session: SessionInfo;
  onboarding: OnboardingState | null;
  rawSnapshot: string;
  actions: TierActions;
}
