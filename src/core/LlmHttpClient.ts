export type HttpCallOptions = {
  readonly url: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly timeoutMs: number;
  readonly label: string;
  /** Bearer token for Authorization header (Cerebras, FreeLLM). Omit for local Ollama. */
  readonly authToken?: string;
  /** Pass false to disable thinking mode for qwen3/reasoning models on Ollama. */
  readonly think?: boolean;
};

export type HttpCallResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

export async function callLlmEndpoint(opts: HttpCallOptions): Promise<HttpCallResult> {
  const { url, model, systemPrompt, userContent, timeoutMs, label, authToken, think } = opts;

  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
  // Disable thinking mode for qwen3 models on local Ollama to avoid token waste
  if (think === false) {
    payload['think'] = false;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken !== undefined) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort =
      typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'AbortError';
    const message = isAbort
      ? `timeout after ${timeoutMs / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, error: `${label} unreachable: ${message}` };
  }

  clearTimeout(timer);

  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: `${label} API error: ${response.status} ${response.statusText} — ${bodyText.slice(0, 200)}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { ok: false, error: `${label} response parse error: ${String(err)}` };
  }

  const text = extractContent(json);
  if (text === null) {
    return { ok: false, error: `${label} response missing choices[0].message.content` };
  }

  return { ok: true, output: text.trim() };
}

export function extractContent(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const choices = (json as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string') return null;
  return content;
}
