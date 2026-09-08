import type { OpenAIConnectionConfig, OpenAIRetryEvent } from "./config.js";
import { OpenAIRequestError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function connection(config: OpenAIConnectionConfig): Required<Pick<OpenAIConnectionConfig, "baseUrl" | "auth" | "timeoutMs" | "maxAttempts">> & Pick<OpenAIConnectionConfig, "apiKey" | "onRetry"> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new OpenAIRequestError("OpenAI base URL is required", "upstream", false);
  return {
    baseUrl,
    auth: config.auth ?? "bearer",
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.onRetry ? { onRetry: config.onRetry } : {}),
  };
}

export function openAIHeaders(config: Pick<OpenAIConnectionConfig, "auth" | "apiKey">): Record<string, string> {
  const auth = config.auth ?? "bearer";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "bearer") {
    if (!config.apiKey) throw new OpenAIRequestError("OpenAI connection requires an API key for bearer authentication", "authentication", false);
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), 30_000);
  }
  return 1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function notifyRetry(config: ReturnType<typeof connection>, event: OpenAIRetryEvent): void {
  config.onRetry?.(event);
}

export async function postOpenAIJson<T>(input: {
  readonly config: OpenAIConnectionConfig;
  readonly path: string;
  readonly body: unknown;
  readonly label: string;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const config = connection(input.config);
  const endpoint = `${config.baseUrl}/${input.path.replace(/^\/+/, "")}`;
  const headers = openAIHeaders(config);

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    if (input.signal?.aborted) throw input.signal.reason;
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(input.body), signal });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      const timedOut = timeoutSignal.aborted;
      if (attempt >= config.maxAttempts) {
        throw new OpenAIRequestError(
          `${input.label} ${timedOut ? "timed out" : "request failed"} after ${attempt} attempt(s) (${endpoint})`,
          timedOut ? "timeout" : "transport",
          true,
          undefined,
          { cause: error },
        );
      }
      const delayMs = retryDelayMs(attempt, null);
      notifyRetry(config, { attempt, maxAttempts: config.maxAttempts, delayMs, endpoint, category: "transport" });
      await sleep(delayMs, input.signal);
      continue;
    }

    if (response.ok) {
      try {
        return await response.json() as T;
      } catch (error) {
        throw new OpenAIRequestError(`${input.label} returned invalid JSON`, "invalid_response", false, response.status, { cause: error });
      }
    }

    const detail = (await response.text()).slice(0, 4_000);
    const retryable = RETRYABLE_STATUSES.has(response.status);
    if (!retryable || attempt >= config.maxAttempts) {
      const category = response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 429 ? "rate_limit" : "upstream";
      throw new OpenAIRequestError(`${input.label} ${response.status} after ${attempt} attempt(s): ${detail}`, category, retryable, response.status);
    }
    const delayMs = retryDelayMs(attempt, response.headers.get("retry-after"));
    notifyRetry(config, { attempt, maxAttempts: config.maxAttempts, delayMs, endpoint, status: response.status, category: "http" });
    await sleep(delayMs, input.signal);
  }

  throw new OpenAIRequestError(`${input.label} retry loop exited unexpectedly`, "upstream", false);
}
