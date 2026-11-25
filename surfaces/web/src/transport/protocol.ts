// Web 端与守护进程之间的线格式（与 Rust `IpcRequest` / `IpcResponse` / `ViewPatch` 对齐）。
import type { ViewPatch, ViewSnapshot } from "../model/state.js";

export interface IpcRequestEnvelope {
  method: string;
  params?: unknown;
}

export interface ChatParams {
  message: string;
  thread_id: string | null;
  peer_id: string | null;
  workspace_dir: string | null;
  verifier_dag: null;
  router_attempted_forbidden_tools: string[];
}

export interface WsEnvelope {
  id: number;
  request: IpcRequestEnvelope;
}

export interface WsSnapshotMessage {
  type: "snapshot";
  state: ViewSnapshot;
}

export interface WsPatchMessage {
  type: "patch";
  patch: ViewPatch;
}

export interface WsTokenMessage {
  type: "token";
  messageId: string;
  seq: number;
  text: string;
}

export type ToolCardKind = "tool" | "approval" | "error";

export interface WsToolMessage {
  type: ToolCardKind;
  id: string;
  title: string;
  detail?: string;
}

export interface WsReadyMessage {
  type: "ready";
  transport: "websocket";
}

export interface WsResponseMessage {
  type: "response";
  id: number;
  response: { kind: string; data?: unknown };
}

export interface WsErrorMessage {
  type: "error";
  detail: string;
}

export type WsInboundMessage =
  | WsSnapshotMessage
  | WsPatchMessage
  | WsTokenMessage
  | WsToolMessage
  | WsReadyMessage
  | WsResponseMessage
  | WsErrorMessage
  | { type: "pong" };

export function chatEnvelope(id: number, message: string): WsEnvelope {
  return {
    id,
    request: {
      method: "chat",
      params: {
        message,
        thread_id: null,
        peer_id: null,
        workspace_dir: null,
        verifier_dag: null,
        router_attempted_forbidden_tools: [],
      } satisfies ChatParams,
    },
  };
}
