import axios from 'axios';
import { SYSTEM_PROMPT, buildUserPrompt, OVERVIEW_SYSTEM_PROMPT, buildOverviewPrompt } from './prompts.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// One reusable Groq call that always returns parsed JSON.
export async function chatJson(system, user, { temperature = 0.3, maxTokens = 600 } = {}) {
  if (!process.env.GROQ_API_KEY) {
    const err = new Error('GROQ_API_KEY is not set in server/.env');
    err.code = 'NO_KEY';
    throw err;
  }
  const { data } = await axios.post(
    GROQ_URL,
    {
      model: MODEL(),
      temperature,
      max_tokens: maxTokens + 1500, // headroom: reasoning tokens count toward the limit
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 }
  );
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

const list = (v, max = 4) => (Array.isArray(v) ? v.slice(0, max).map(String) : []);

export async function summariseRepo(analysis) {
  const parsed = await chatJson(SYSTEM_PROMPT, buildUserPrompt(analysis));
  return {
    verdict: String(parsed.verdict || ''),
    suitableFor: String(parsed.suitableFor || ''),
    strengths: list(parsed.strengths),
    risks: list(parsed.risks),
    recommendations: list(parsed.recommendations),
    model: MODEL(),
  };
}

export async function overviewRepo(input) {
  const parsed = await chatJson(OVERVIEW_SYSTEM_PROMPT, buildOverviewPrompt(input), { maxTokens: 700 });
  return {
    overview: String(parsed.overview || ''),
    audience: String(parsed.audience || ''),
    keyFeatures: list(parsed.keyFeatures, 5),
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack.slice(0, 6).map(String) : [],
    gettingStarted: String(parsed.gettingStarted || ''),
    model: MODEL(),
  };
}
