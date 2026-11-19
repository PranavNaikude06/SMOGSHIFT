// Thin Groq client (OpenAI-compatible chat completions, JSON mode).
// Callers must validate the returned object with src/schemas.js: the model is untrusted.

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

const TIMEOUT_MS = 12_000;
const TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 600; // callers pass a tighter per-prompt budget; free-tier limits count tokens
const LANGUAGE_NAMES = Object.freeze({ en: 'English', hi: 'Hindi (Devanagari script)', mr: 'Marathi (Devanagari script)' });

/** Failure talking to the model. `code` is one of: no_key, timeout, network, http, bad_json. */
export class LlmError extends Error {
  /**
   * @param {'no_key' | 'timeout' | 'network' | 'http' | 'bad_json'} code
   * @param {string} message
   * @param {number} [status] HTTP status for code "http"
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

function buildMessages({ system, user, image, language }) {
  const languageRule = language ? `\nWrite every human-readable string in ${LANGUAGE_NAMES[language]}.` : '';
  const userContent = image
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }]
    : user;
  return [
    { role: 'system', content: `${system}${languageRule}\nRespond with a single JSON object only.` },
    { role: 'user', content: userContent },
  ];
}

async function post(body, { apiKey, fetchImpl }) {
  try {
    return await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new LlmError('timeout', 'The AI service took too long to answer.');
    throw new LlmError('network', 'Could not reach the AI service.');
  }
}

function parseObject(content) {
  try {
    const value = JSON.parse(content);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through to the error below
  }
  throw new LlmError('bad_json', 'The AI service returned an unreadable answer.');
}

/**
 * Asks the model for a JSON object.
 * @param {{ system: string, user: string, image?: string, language?: 'en' | 'hi' | 'mr', maxTokens?: number }} prompt
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Record<string, unknown>>} parsed but NOT validated object
 * @throws {LlmError}
 */
export async function chatJson(prompt, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new LlmError('no_key', 'AI features are not configured.');

  const response = await post({
    model,
    messages: buildMessages(prompt),
    temperature: TEMPERATURE,
    max_completion_tokens: prompt.maxTokens ?? DEFAULT_MAX_TOKENS,
    response_format: { type: 'json_object' },
  }, { apiKey, fetchImpl });

  if (!response.ok) throw new LlmError('http', `The AI service answered with HTTP ${response.status}.`, response.status);

  const data = await response.json().catch(() => null);
  return parseObject(data?.choices?.[0]?.message?.content);
}
