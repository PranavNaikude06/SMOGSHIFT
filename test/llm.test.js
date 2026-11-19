import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatJson, LlmError, GROQ_URL } from '../src/llm.js';

const OPTIONS = { apiKey: 'test-key', model: 'test-model' };

/** Fake fetch that records the request and replies with the given status/body. */
function fakeFetch({ status = 200, content = '{"ok":true}', body } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = body ?? { choices: [{ message: { content } }] };
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { impl, calls };
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof LlmError && err.code === code);

test('sends an OpenAI-compatible JSON-mode request and parses the reply', async () => {
  const { impl, calls } = fakeFetch({ content: '{"tasks":[]}' });
  const result = await chatJson({ system: 'sys', user: 'hi' }, { ...OPTIONS, fetchImpl: impl });

  assert.deepEqual(result, { tasks: [] });
  const [{ url, init, body }] = calls;
  assert.equal(url, GROQ_URL);
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'hi');
  assert.ok(init.signal instanceof AbortSignal);
});

test('uses the per-prompt token budget when given, a safe default otherwise', async () => {
  const { impl, calls } = fakeFetch();
  await chatJson({ system: 's', user: 'u', maxTokens: 400 }, { ...OPTIONS, fetchImpl: impl });
  await chatJson({ system: 's', user: 'u' }, { ...OPTIONS, fetchImpl: impl });
  assert.equal(calls[0].body.max_completion_tokens, 400);
  assert.ok(calls[1].body.max_completion_tokens > 0);
});

test('adds the reply language to the system prompt', async () => {
  const { impl, calls } = fakeFetch();
  await chatJson({ system: 'sys', user: 'hi', language: 'mr' }, { ...OPTIONS, fetchImpl: impl });
  assert.match(calls[0].body.messages[0].content, /Marathi/);
});

test('sends an image as an image_url content part', async () => {
  const { impl, calls } = fakeFetch();
  const image = 'data:image/jpeg;base64,AAAA';
  await chatJson({ system: 'sys', user: 'look', image }, { ...OPTIONS, fetchImpl: impl });
  const [text, picture] = calls[0].body.messages[1].content;
  assert.deepEqual(text, { type: 'text', text: 'look' });
  assert.deepEqual(picture, { type: 'image_url', image_url: { url: image } });
});

test('fails fast with no_key and never calls the API', async () => {
  const { impl, calls } = fakeFetch();
  await rejectsWith(chatJson({ system: 's', user: 'u' }, { ...OPTIONS, apiKey: '', fetchImpl: impl }), 'no_key');
  assert.equal(calls.length, 0);
});

test('maps HTTP errors (incl. 429 rate limit) to code http with the status', async () => {
  for (const status of [429, 500]) {
    const { impl } = fakeFetch({ status, body: { error: { message: 'nope' } } });
    await assert.rejects(
      chatJson({ system: 's', user: 'u' }, { ...OPTIONS, fetchImpl: impl }),
      (err) => err instanceof LlmError && err.code === 'http' && err.status === status,
    );
  }
});

test('maps a timeout to code timeout', async () => {
  const impl = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  await rejectsWith(chatJson({ system: 's', user: 'u' }, { ...OPTIONS, fetchImpl: impl }), 'timeout');
});

test('maps other network failures to code network', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await rejectsWith(chatJson({ system: 's', user: 'u' }, { ...OPTIONS, fetchImpl: impl }), 'network');
});

test('rejects non-JSON, non-object or missing content as bad_json', async () => {
  const replies = [
    { content: 'not json' },
    { content: '[1,2]' },
    { body: { choices: [{ message: {} }] } },
    { body: { choices: [] } },
  ];
  for (const reply of replies) {
    const { impl } = fakeFetch(reply);
    await rejectsWith(chatJson({ system: 's', user: 'u' }, { ...OPTIONS, fetchImpl: impl }), 'bad_json');
  }
});
