import axios from 'axios';

const gh = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
  },
});

export function parseRepo(input = '') {
  const m = input.trim().replace(/\.git$/, '').match(/^(?:https?:\/\/(?:www\.)?)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

const get = (url, params) => gh.get(url, { params }).then((r) => r.data);

export async function fetchRepoData(owner, repo) {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const q = (state) => `repo:${owner}/${repo} type:issue state:${state}`;
  const [info, languages, commits, contributors, openIssues, closedIssues] = await Promise.all([
    get(`/repos/${owner}/${repo}`),
    get(`/repos/${owner}/${repo}/languages`),
    get(`/repos/${owner}/${repo}/commits`, { since, per_page: 100 }),
    get(`/repos/${owner}/${repo}/contributors`, { per_page: 10 }).catch(() => []),
    get('/search/issues', { q: q('open'), per_page: 1 }).then((d) => d.total_count),
    get('/search/issues', { q: q('closed'), per_page: 1 }).then((d) => d.total_count),
  ]);
  return { info, languages, commits, contributors, openIssues, closedIssues };
}

export async function fetchReadme(owner, repo) {
  try {
    const { data } = await gh.get(`/repos/${owner}/${repo}/readme`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
      responseType: 'text',
      timeout: 8000,
    });
    return typeof data === 'string' ? data : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Repository discovery used by the recommendation chatbot
// 1. several differently-worded searches run in parallel and are merged
// 2. if the pool is too small, filters loosen step by step
// 3. candidates are cleaned (no archived, forks, stale or description-less repos) and pre-ranked
// 4. the best few get a README excerpt so the LLM can judge what they really do
// ---------------------------------------------------------------------------
const clean = (s) => String(s).replace(/[^\w\s.#+-]/g, ' ').replace(/\s+/g, ' ').trim();

const SEARCH_TTL = 10 * 60 * 1000;
const README_TTL = 60 * 60 * 1000;
const searchCache = new Map();
const readmeCache = new Map();

const cacheGet = (map, key, ttl) => {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < ttl ? hit.value : null;
};
const cacheSet = (map, key, value) => {
  if (map.size > 300) map.delete(map.keys().next().value);
  map.set(key, { at: Date.now(), value });
};

async function runSearch(q) {
  const hit = cacheGet(searchCache, q, SEARCH_TTL);
  if (hit) return hit;
  const data = await get('/search/repositories', { q, per_page: 15 });
  const items = data.items.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    url: r.html_url,
    stars: r.stargazers_count,
    language: r.language,
    topics: r.topics || [],
    pushedAt: r.pushed_at,
    fork: r.fork,
    archived: r.archived,
  }));
  cacheSet(searchCache, q, items);
  return items;
}

// Different wordings of the same need: strict keywords, LLM synonym variants, and topic tags.
function termSets({ kw, variants, topics }) {
  const sets = [];
  if (kw.length) sets.push(kw.join(' '));
  variants.forEach((v) => sets.push(v));
  // GitHub requires every word to match, so also try shorter combinations of the core keywords
  if (kw.length > 3) sets.push(kw.slice(0, 3).join(' '));
  if (kw.length > 2) sets.push(kw.slice(0, 2).join(' '));
  topics.slice(0, 2).forEach((t) => sets.push(`topic:${t}${kw[0] ? ' ' + kw[0] : ''}`));
  const seen = new Set();
  return sets.filter((t) => {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 7);
}

function qualifiers(floor, language, cutoff) {
  return ['archived:false', 'fork:false', `stars:>=${floor}`, `pushed:>${cutoff}`, language && `language:${language}`]
    .filter(Boolean).join(' ');
}

// README start with badges, HTML, links and code removed, so the LLM sees real prose
export function excerpt(md = '', n = 500) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[|=*_`>~-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

async function fetchExcerpt(fullName) {
  const hit = cacheGet(readmeCache, fullName, README_TTL);
  if (hit !== null) return hit;
  const [owner, repo] = fullName.split('/');
  const text = excerpt(await fetchReadme(owner, repo));
  cacheSet(readmeCache, fullName, text);
  return text;
}

// Used for "something like X": returns X's topics and description (null if it does not exist)
export async function fetchRepoBrief(fullName) {
  const m = parseRepo(fullName);
  if (!m) return null;
  try {
    const info = await get(`/repos/${m.owner}/${m.repo}`);
    return { fullName: info.full_name, description: info.description, topics: info.topics || [] };
  } catch {
    return null;
  }
}

export async function findRepos({ keywords, queries = [], topics = [], language = null, minStars = null, exclude = [] }) {
  const blocked = new Set(exclude.map((n) => n.toLowerCase()));
  const kw = (Array.isArray(keywords) ? keywords : []).map(clean).filter(Boolean).slice(0, 5);
  if (!kw.length) return [];
  const lang = /^[\w+#.-]{1,30}$/.test(language || '') ? language : null;
  const floor = Number(minStars) > 0 ? Math.floor(Number(minStars)) : 50;
  const cutoff = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);

  // Strict + synonym queries first. Topic-tag queries are broad and noisy, so they only fill gaps.
  // Then loosen step by step: lower the star floor, drop the least important keyword, drop the language.
  const levels = [
    { kw, variants: queries, topics: [], language: lang, floor },
    { kw, variants: queries, topics, language: lang, floor },
    { kw, variants: queries, topics, language: lang, floor: Math.min(floor, 10) },
    { kw: kw.slice(0, Math.max(1, kw.length - 1)), variants: [], topics, language: lang, floor: Math.min(floor, 10) },
    { kw: kw.slice(0, 2), variants: [], topics, language: null, floor: Math.min(floor, 10) },
  ];

  const seen = new Map();
  const ran = new Set();
  let rateErr = null;

  for (const lv of levels) {
    const base = qualifiers(lv.floor, lv.language, cutoff);
    const qs = termSets(lv).map((t) => `${t}${t.includes('topic:') ? '' : ' in:name,description,topics'} ${base}`).filter((q) => !ran.has(q));
    qs.forEach((q) => ran.add(q));
    const results = await Promise.allSettled(qs.map(runSearch));
    results.forEach((r) => {
      if (r.status === 'rejected') {
        const status = r.reason?.response?.status;
        if (status === 403 || status === 429) rateErr = r.reason;
        return;
      }
      const n = r.value.length;
      r.value.forEach((repo, i) => {
        if (repo.fork || repo.archived || !repo.description || blocked.has(repo.fullName.toLowerCase())) return;
        const e = seen.get(repo.fullName) || { repo, rel: 0, hits: 0 };
        e.rel += (n - i) / n; // position in GitHub's own relevance order
        e.hits += 1;          // found by several different queries = probably relevant
        seen.set(repo.fullName, e);
      });
    });
    if (seen.size >= 8) break;
  }
  if (!seen.size && rateErr) throw rateErr;

  const now = Date.now();
  const top = [...seen.values()]
    .map(({ repo, rel, hits }) => {
      const days = (now - new Date(repo.pushedAt).getTime()) / 864e5;
      const fresh = days < 90 ? 2 : days < 365 ? 1 : 0;
      return { repo, score: rel * 2 + hits + fresh + Math.log10(repo.stars + 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => ({ ...x.repo }));
  // README excerpts cost one GitHub core request each, so only the top 6 get one
  const withReadme = top.slice(0, 6);

  await Promise.all(withReadme.map(async (r) => { r.excerpt = await fetchExcerpt(r.fullName); }));
  return top;
}
