export type ImportSource = "codex" | "cursor";

export type ImportObservationType =
  | "conversation"
  | "command_run"
  | "file_edit"
  | "tool"
  | "other";

export interface ImportObservation {
  timestamp: string;
  type: ImportObservationType;
  userPrompt?: string;
  assistantResponse?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}

export interface ImportSession {
  source: ImportSource;
  sessionId: string;
  project?: string;
  cwd?: string;
  title?: string;
  startedAt: string;
  endedAt: string;
  contentHash: string;
  observations: ImportObservation[];
  sourcePath?: string;
}

export interface DiscoverItem {
  source: ImportSource;
  sessionId: string;
  title?: string;
  cwd?: string;
  project?: string;
  startedAt?: string;
  endedAt?: string;
  observationCount: number;
  contentHash: string;
  sourcePath?: string;
  skippedReason?: string;
}

export interface SyncStats {
  discovered: number;
  synced: number;
  skipped: number;
  failed: number;
  observationsWritten: number;
  errors: Array<{ sessionId: string; error: string }>;
}
