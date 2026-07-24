import type { ImportObservation, ImportSession } from "./ir.js";

export interface AmClientOptions {
  baseUrl: string;
  secret: string;
  /** Per-request timeout in ms. 0 = wait until the server responds (no AbortSignal). */
  timeoutMs?: number;
  /** Retries for a single HTTP call on timeout/network errors. */
  retries?: number;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket")
  ) {
    return true;
  }
  // NAS/nginx gateway overload — retry the same observe.
  return /→\s*(429|502|503|504)\b/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class AmClient {
  private baseUrl: string;
  private secret: string;
  private timeoutMs: number;
  private retries: number;

  constructor(opts: AmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 0;
    this.retries = Math.max(0, opts.retries ?? 3);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.secret) h.Authorization = `Bearer ${this.secret}`;
    return h;
  }

  /**
   * Adaptive per-request budget when a fixed timeout is configured:
   * larger JSON bodies get more time. timeoutMs=0 still means unlimited.
   */
  private budgetForBody(body: unknown, overrideMs?: number): number {
    if (overrideMs !== undefined) return overrideMs;
    if (this.timeoutMs <= 0) return 0;
    let bytes = 0;
    try {
      bytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body), "utf8");
    } catch {
      bytes = 0;
    }
    // ~50KB/s floor assumption on a slow link + 60s base headroom
    const fromSize = 60_000 + Math.ceil(bytes / 50) * 1000;
    return Math.max(this.timeoutMs, fromSize);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const budget = this.budgetForBody(body, opts?.timeoutMs);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const init: RequestInit = {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
        };
        if (budget > 0) {
          init.signal = AbortSignal.timeout(budget);
        }

        const res = await fetch(`${this.baseUrl}${path}`, init);
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
      } catch (err) {
        lastError = err;
        const canRetry = attempt < this.retries && isRetryable(err);
        if (!canRetry) break;
        const wait = 500 * 2 ** attempt;
        console.warn(
          `retry ${attempt + 1}/${this.retries} ${method} ${path}: ${err instanceof Error ? err.message : err} (wait ${wait}ms)`,
        );
        await sleep(wait);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  async livez(): Promise<boolean> {
    try {
      // Probe should fail fast even when import timeout is unlimited.
      await this.request("GET", "/agentmemory/livez", undefined, {
        timeoutMs: 10_000,
      });
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
    const total = session.observations.length;
    await this.sessionStart(session, amSessionId);
    let written = 0;
    try {
      for (const obs of session.observations) {
        await this.observe(session, amSessionId, obs);
        written += 1;
        if (total >= 50 && (written % 50 === 0 || written === total)) {
          console.log(
            `  … ${session.source}:${session.sessionId} ${written}/${total} observations`,
          );
        }
      }
    } finally {
      await this.sessionEnd(amSessionId);
    }
    return written;
  }
}
