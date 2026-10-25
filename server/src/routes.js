import { Router } from 'express';
import mongoose from 'mongoose';
import Analysis from './model.js';
import { parseRepo, fetchRepoData, findRepos, fetchRepoBrief, fetchReadme } from './github.js';
import { languageStats, commitStats, contributorStats, healthScore } from './analytics.js';
import { summariseRepo, overviewRepo, chatJson } from './llm.js';
import { INTENT_SYSTEM_PROMPT, buildIntentPrompt, RANK_SYSTEM_PROMPT, buildRankPrompt } from './prompts.js';

const router = Router();
const TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 60) * 60 * 1000;

// Skip the cache entirely when MongoDB is not connected; otherwise Mongoose buffers each call for 10 s.
const dbReady = () => mongoose.connection.readyState === 1;

async function readCache(fullName) {
  if (!dbReady()) return null;
  try {
    const doc = await Analysis.findOne({ fullName }).maxTimeMS(1500).lean();
    if (doc && Date.now() - new Date(doc.fetchedAt).getTime() < TTL_MS) return doc;
  } catch { /* cache unavailable */ }
  return null;
}

async function writeCache(fullName, result) {
  if (!dbReady()) return;
  try {
    await Analysis.findOneAndUpdate({ fullName }, { result, fetchedAt: new Date() }, { upsert: true }).maxTimeMS(1500);
  } catch { /* cache unavailable */ }
}

// Shared by /analyse and /summary: returns cached analysis or builds a fresh one.
async function getAnalysis(parsed) {
  const fullName = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const cached = await readCache(fullName);
  if (cached) return { ...cached.result, cached: true, fetchedAt: cached.fetchedAt };

  const raw = await fetchRepoData(parsed.owner, parsed.repo);
  const commits = commitStats(raw.commits);
  const result = {
    repo: {
      fullName: raw.info.full_name,
      description: raw.info.description,
      url: raw.info.html_url,
      stars: raw.info.stargazers_count,
      forks: raw.info.forks_count,
      openIssues: raw.openIssues,
      closedIssues: raw.closedIssues,
      pushedAt: raw.info.pushed_at,
      license: raw.info.license?.spdx_id || 'None',
      topics: raw.info.topics || [],
    },
    health: healthScore({ ...raw, commits }),
    languages: languageStats(raw.languages),
    commits,
    contributors: contributorStats(raw.contributors),
  };
  await writeCache(fullName, result);
  return { ...result, cached: false, fetchedAt: new Date() };
}

function sendError(res, err) {
  const status = err.response?.status;
  if (err.code === 'NO_KEY') return res.status(503).json({ error: 'AI summary is not configured. Add GROQ_API_KEY to server/.env.' });
  if (err.response?.config?.url?.includes('groq.com'))
    return res.status(502).json({ error: status === 429 ? 'Groq rate limit reached. Try again in a minute.' : 'The AI service failed. Try again.' });
  if (err instanceof SyntaxError) return res.status(502).json({ error: 'The AI returned an unreadable answer. Try again.' });
  if (status === 404) return res.status(404).json({ error: 'Repository not found or it is private.' });
  if (status === 403 || status === 429)
    return res.status(429).json({ error: 'GitHub rate limit reached. Add a GITHUB_TOKEN to server/.env or try later.' });
  console.error(err.message);
  res.status(502).json({ error: 'Could not reach GitHub. Try again shortly.' });
}

router.get('/analyse', async (req, res) => {
  const parsed = parseRepo(req.query.repo);
  if (!parsed) return res.status(400).json({ error: 'Enter a repository as owner/repo or a GitHub URL.' });
  try {
    res.json(await getAnalysis(parsed));
  } catch (err) { sendError(res, err); }
});

// LLM summary: metrics are re-read server-side (never trusted from the client)
router.post('/summary', async (req, res) => {
  const parsed = parseRepo(req.body?.repo);
  if (!parsed) return res.status(400).json({ error: 'Enter a repository as owner/repo or a GitHub URL.' });
  try {
    const analysis = await getAnalysis(parsed);
    res.json(await summariseRepo(analysis));
  } catch (err) { sendError(res, err); }
});

// "What is this project about?" summary, built from the README (separate from the metrics summary).
// Small in-memory cache so repeat clicks do not burn LLM calls.
const overviewCache = new Map();
router.post('/overview', async (req, res) => {
  const parsed = parseRepo(req.body?.repo);
  if (!parsed) return res.status(400).json({ error: 'Enter a repository as owner/repo or a GitHub URL.' });
  const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return res.json({ ...hit.data, cached: true });
  try {
    const analysis = await getAnalysis(parsed);
    const readme = await fetchReadme(parsed.owner, parsed.repo);
    if (!readme && !analysis.repo.description) {
      return res.status(404).json({ error: 'This repository has no README or description to summarise.' });
    }
    const data = {
      ...(await overviewRepo({
        fullName: analysis.repo.fullName,
        description: analysis.repo.description,
        topics: analysis.repo.topics,
        readme,
      })),
      usedReadme: Boolean(readme),
    };
    overviewCache.set(key, { at: Date.now(), data });
    res.json({ ...data, cached: false });
  } catch (err) { sendError(res, err); }
});

const KINDS = ['library', 'app', 'tool', 'template', 'tutorial', 'any'];
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

// Keeps a search plan small and safe before it is stored or sent to GitHub
function sanitizePlan(p) {
  if (!p || typeof p !== 'object') return null;
  const keywords = (Array.isArray(p.keywords) ? p.keywords : [])
    .map((k) => String(k).replace(/[^\w\s.#+-]/g, ' ').trim().slice(0, 30))
    .filter(Boolean)
    .slice(0, 5);
  if (!keywords.length) return null;
  const language = /^[\w+#.-]{1,30}$/.test(p.language || '') ? p.language : null;
  const minStars = Number(p.minStars) > 0 ? Math.floor(Number(p.minStars)) : null;
  const topics = (Array.isArray(p.topics) ? p.topics : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40))
    .filter(Boolean)
    .slice(0, 3);
  const kind = KINDS.includes(p.kind) ? p.kind : 'any';
  const similarTo = REPO_NAME.test(String(p.similarTo || '')) ? String(p.similarTo) : null;
  return { keywords, language, minStars, topics, kind, similarTo };
}

const sanitizeQueries = (q) => (Array.isArray(q) ? q : [])
  .map((x) => String(x).replace(/[^\w\s.#+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40))
  .filter(Boolean)
  .slice(0, 4);

const sanitizeShown = (list) => (Array.isArray(list) ? list : [])
  .map(String)
  .filter((n) => REPO_NAME.test(n))
  .slice(-100);

// Recommendation chatbot:
// LLM updates the chat's plan -> several GitHub searches are merged, cleaned and pre-ranked
// -> README excerpts are fetched -> LLM picks the best and explains why (and any caveat).
router.post('/recommend', async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: 'Type what you are looking for.' });
  const prev = sanitizePlan(req.body?.plan);
  const shown = sanitizeShown(req.body?.shown);

  try {
    const intent = await chatJson(INTENT_SYSTEM_PROMPT, buildIntentPrompt(message, prev), { temperature: 0.1, maxTokens: 500 });
    if (intent.needsClarification && !prev) {
      return res.json({ reply: String(intent.clarifyingQuestion || 'Could you tell me a bit more about what you need?'), picks: [], plan: null });
    }
    if (prev && intent.topicChanged) {
      return res.json({
        reply: `That sounds like a different topic. Start a New chat to keep this one focused on "${prev.keywords.join(', ')}".`,
        picks: [],
        plan: prev,
      });
    }

    const plan = sanitizePlan(intent);
    if (!plan) return res.json({ reply: 'I could not turn that into a search. Try describing the project you want.', picks: [], plan: prev });

    // "something like X": borrow X's topics and never recommend X itself
    const similar = plan.similarTo ? await fetchRepoBrief(plan.similarTo) : null;
    if (plan.similarTo && !similar) plan.similarTo = null;
    const topics = [...new Set([...plan.topics, ...(similar?.topics || [])])].slice(0, 3);
    const exclude = [...shown, ...(similar ? [similar.fullName] : [])];

    const repos = await findRepos({
      keywords: plan.keywords,
      queries: sanitizeQueries(intent.queries),
      topics,
      language: plan.language,
      minStars: plan.minStars,
      exclude,
    });

    if (!repos.length) {
      // keep the previous plan so a dead-end refinement does not ruin the chat
      const reply = shown.length
        ? 'I have already shown you the best matches I could find for this. Try loosening a filter, changing the language, or using different words.'
        : 'I could not find repositories matching that. Try removing a filter or using broader words.';
      return res.json({ reply, picks: [], plan: prev });
    }

    const ranked = await chatJson(RANK_SYSTEM_PROMPT, buildRankPrompt(message, repos, plan), { maxTokens: 900 });
    // Anti-hallucination: keep only picks that exist in the real search results
    const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
    const toPick = (r, reason, caveat = '') => ({
      fullName: r.fullName, url: r.url, stars: r.stars, language: r.language, reason, caveat,
    });
    let picks = (Array.isArray(ranked.picks) ? ranked.picks : [])
      .map((p) => {
        const repo = byName.get(String(p.fullName).toLowerCase());
        return repo && toPick(repo, String(p.reason || ''), String(p.caveat || ''));
      })
      .filter(Boolean)
      .slice(0, 5);

    // The LLM named repos but none were real: fall back to the best pre-ranked results
    if (!picks.length && Array.isArray(ranked.picks) && ranked.picks.length) {
      picks = repos.slice(0, 3).map((r) => toPick(r, (r.description || '').slice(0, 120)));
    }

    res.json({ reply: String(ranked.intro || 'Here is what I found.'), picks, plan });
  } catch (err) { sendError(res, err); }
});

export default router;
