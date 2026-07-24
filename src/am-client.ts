import type { ImportObservation, ImportSession } from "./ir.js";

export interface AmClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

export class AmClient {
  private baseUrl: string;
  private secret: string;
  private timeoutMs: number;

  constructor(opts: AmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.secret) h.Authorization = `Bearer ${this.secret}`;
    return h;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) {
      const detail =
        typeof json === "object" && json && "error" in json
          ? String((json as { error: unknown }).error)
          : text.slice(0, 240);
      throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
    }
    return json;
  }

  async livez(): Promise<boolean> {
    try {
      await this.request("GET", "/agentmemory/livez");
      return true;
    } catch {
      return false;
    }
  }

  async sessionStart(session: ImportSession, amSessionId: string): Promise<void> {
    await this.request("POST", "/agentmemory/session/start", {
      sessionId: amSessionId,
      project: session.project || "imported",
      cwd: session.cwd || session.project || process.cwd(),
      title: session.title || `${session.source}:${session.sessionId}`,
      agentId: `history-import-${session.source}`,
    });
  }

  async sessionEnd(amSessionId: string): Promise<void> {
    await this.request("POST", "/agentmemory/session/end", {
      sessionId: amSessionId,
    });
  }

  async observe(
    session: ImportSession,
    amSessionId: string,
    obs: ImportObservation,
  ): Promise<void> {
    const project = session.project || "imported";
    const cwd = session.cwd || project;
    const base = {
      sessionId: amSessionId,
      project,
      cwd,
      timestamp: obs.timestamp,
    };

    if (obs.userPrompt) {
      await this.request("POST", "/agentmemory/observe", {
        ...base,
        hookType: "prompt_submit",
        data: { prompt: obs.userPrompt },
      });
    }

    if (obs.assistantResponse) {
      // observe() only indexes userPrompt / tool_* into synthetic narrative.
      // Store assistant text as tool_output so it remains searchable.
      await this.request("POST", "/agentmemory/observe", {
        ...base,
        hookType: "post_tool_use",
        data: {
          tool_name: "Assistant",
          tool_input: { role: "assistant" },
          tool_output: obs.assistantResponse,
        },
      });
    }

    if (obs.toolName) {
      await this.request("POST", "/agentmemory/observe", {
        ...base,
        hookType: "post_tool_use",
        data: {
          tool_name: obs.toolName,
          tool_input: obs.toolInput ?? {},
          tool_output: obs.toolOutput ?? "",
        },
      });
    }
  }

  async writeSession(
    session: ImportSession,
    amSessionId: string,
  ): Promise<number> {
    await this.sessionStart(session, amSessionId);
    let written = 0;
    try {
      for (const obs of session.observations) {
        await this.observe(session, amSessionId, obs);
        written += 1;
      }
    } finally {
      await this.sessionEnd(amSessionId);
    }
    return written;
  }
}
