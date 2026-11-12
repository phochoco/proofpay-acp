// One tiny JSON-in/JSON-out helper over Anthropic or OpenAI. No SDKs.
// With no API key the agents fall back to scripted behaviour, and every memo is labelled
// with where it came from ("llm" or "scripted") so the UI never pretends.
import { env } from './env.js';

const anthropicKey = env('ANTHROPIC_API_KEY');
const openaiKey = env('OPENAI_API_KEY');

export const llmInfo = anthropicKey
  ? { provider: 'anthropic', model: env('ANTHROPIC_MODEL', 'claude-haiku-5-5') }
  : openaiKey
    ? { provider: 'openai', model: env('OPENAI_MODEL', 'gpt-4o-mini') }
    : { provider: 'scripted', model: null };

async function callAnthropic(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: llmInfo.model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: llmInfo.model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content;
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Ask the model for a JSON object. `fallback()` supplies the scripted answer when there is no
 * key or the call fails, so a flaky network never strands money in the middle of a job.
 */
export async function askJSON({ system, user, fallback }) {
  if (llmInfo.provider === 'scripted') return { ...fallback(), source: 'scripted' };
  try {
    const sys = `${system}\nReply with ONE JSON object only. No markdown, no commentary.`;
    const text = llmInfo.provider === 'anthropic' ? await callAnthropic(sys, user) : await callOpenAI(sys, user);
    return { ...extractJSON(text), source: 'llm' };
  } catch (err) {
    console.warn(`[llm] ${err.message} -> using scripted fallback`);
    return { ...fallback(), source: 'scripted' };
  }
}
