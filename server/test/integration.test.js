// Integration tests: real Express app + real routes/analytics/prompts,
// GitHub replaced by a local stand-in, Groq replaced by a canned responder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';

const GH_PORT = 5056, API_PORT = 5055;
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString();
const seen = { groqCalls: [], ghPaths: [] };

// ---- local GitHub stand-in ----
const repoObj = (n) => ({ full_name: n, name: n.split('/')[1], description: `${n} description`, html_url: `https://github.com/${n}`, stargazers_count: 1200, forks_count: 150, pushed_at: iso(2), license: { spdx_id: 'MIT' }, topics: ['github', 'analytics'], language: 'JavaScript', fork: false, archived: false });
const gh = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; seen.ghPaths.push(p);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (p.includes('/missing/')) return send(404, { message: 'Not Found' });
  if (p.includes('/limited/')) return send(403, { message: 'rate limit' });
  if (p === '/search/issues') return send(200, { total_count: u.searchParams.get('q').includes('state:open') ? 20 : 180 });
  if (p === '/search/repositories') return send(200, { items: ['octo/finder-one', 'octo/finder-two', 'octo/finder-three', 'octo/finder-four', 'octo/finder-five', 'octo/finder-six', 'octo/finder-seven', 'octo/finder-eight'].map(repoObj) });
  if (p.endsWith('/readme')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('# Demo\nA demo project README.'); }
  if (p.endsWith('/languages')) return send(200, { JavaScript: 7000, CSS: 2000, HTML: 1000 });
  if (p.endsWith('/commits')) return send(200, Array.from({ length: 30 }, (_, i) => ({ commit: { author: { date: iso(i * 2), name: 'a' } }, author: { login: i % 3 ? 'alice' : 'bob' } })));
  if (p.endsWith('/contributors')) return send(200, [{ login: 'alice', contributions: 70, avatar_url: '', html_url: '' }, { login: 'bob', contributions: 30, avatar_url: '', html_url: '' }]);
  return send(200, repoObj(p.split('/').slice(2, 4).join('/')));
});

// ---- patch axios BEFORE the app loads ----
const origCreate = axios.create.bind(axios);
axios.create = (c = {}) => origCreate({ ...c, baseURL: `http://127.0.0.1:${GH_PORT}` });
const origPost = axios.post.bind(axios);
axios.post = async (url, body, cfg) => {
  if (!String(url).includes('groq.com')) return origPost(url, body, cfg);
  const sys = body.messages[0].content, usr = body.messages[1].content;
  seen.groqCalls.push({ sys: sys.slice(0, 40), usr });
  let out;
  if (sys.includes('search planner')) out = usr.includes('Previous plan: none') && usr.includes('<untrusted>\nhi\n') ? { needsClarification: true, clarifyingQuestion: 'What do you want to build?' } : { needsClarification: false, topicChanged: false, keywords: ['github', 'analyzer'], queries: ['repo analyzer', 'github stats'], topics: ['github'], kind: 'tool', similarTo: null, language: null, minStars: null };
  else if (sys.includes('recommending GitHub')) out = { intro: 'Here you go.', picks: [{ fullName: 'octo/finder-one', reason: 'Matches.', caveat: '' }, { fullName: 'fake/hallucinated-repo', reason: 'Made up.', caveat: '' }, { fullName: 'OCTO/FINDER-TWO', reason: 'Case-insensitive match.', caveat: '' }] };
  else if (sys.includes('technical writer')) out = { overview: 'A demo.', audience: 'Devs', keyFeatures: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], techStack: ['JS'], gettingStarted: 'npm i' };
  else out = { verdict: 'Healthy.', suitableFor: 'Everyone', strengths: ['s1', 's2', 's3', 's4', 's5'], risks: ['r1'], recommendations: ['x'] };
  return { data: { choices: [{ message: { content: JSON.stringify(out) } }] } };
};

const call = (path, opts) => fetch(`http://127.0.0.1:${API_PORT}/api${path}`, opts).then(async (r) => ({ status: r.status, json: await r.json() }));
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  await new Promise((r) => gh.listen(GH_PORT, r));
  process.env.PORT = API_PORT; process.env.MONGO_URI = 'mongodb://127.0.0.1:1/none'; process.env.GROQ_API_KEY = 'test-key';
  await import('../src/index.js');
  await new Promise((r) => setTimeout(r, 300));
});
after(() => { gh.close(); setTimeout(() => process.exit(0), 100); });

test('IT-01 /analyse returns full analysis for valid repo', async () => {
  const { status, json } = await call('/analyse?repo=octo/demo');
  assert.equal(status, 200);
  for (const k of ['repo', 'health', 'languages', 'commits', 'contributors', 'cached', 'fetchedAt']) assert.ok(k in json, k);
  assert.equal(json.repo.openIssues, 20); assert.equal(json.repo.closedIssues, 180);
  assert.equal(json.languages[0].name, 'JavaScript'); assert.equal(json.contributors.busFactor, 1);
  console.log('   health =', json.health.score, json.health.grade);
});
test('IT-02 /analyse empty input -> 400', async () => assert.equal((await call('/analyse?repo=')).status, 400));
test('IT-03 /analyse unknown repo -> 404', async () => assert.equal((await call('/analyse?repo=octo/missing')).status, 404));
test('IT-04 /analyse GitHub rate limit -> 429 with token hint', async () => {
  const r = await call('/analyse?repo=octo/limited'); assert.equal(r.status, 429); assert.match(r.json.error, /GITHUB_TOKEN/);
});
test('IT-05 /analyse issues 4 core repo calls + 2 search calls', async () => {
  seen.ghPaths.length = 0; await call('/analyse?repo=octo/count');
  assert.equal(seen.ghPaths.filter((x) => x.startsWith('/repos/octo/count')).length, 4);
});
test('IT-06 cache unavailable (no MongoDB) -> analysis still succeeds, cached:false', async () => {
  const r = await call('/analyse?repo=octo/demo'); assert.equal(r.status, 200); assert.equal(r.json.cached, false);
});
test('IT-06b BF-01 regression: with MongoDB down /analyse answers in under 2 s', async () => {
  const t = Date.now(); const r = await call('/analyse?repo=octo/fast'); assert.equal(r.status, 200); assert.ok(Date.now() - t < 2000, 'took ' + (Date.now() - t) + ' ms');
});
test('IT-07 /summary returns capped, well-formed AI summary', async () => {
  const { status, json } = await post('/summary', { repo: 'octo/demo' });
  assert.equal(status, 200); assert.equal(json.verdict, 'Healthy.'); assert.ok(json.strengths.length <= 4); assert.ok(json.model);
});
test('IT-08 /summary sends server-computed metrics, not client-supplied ones', async () => {
  seen.groqCalls.length = 0; await post('/summary', { repo: 'octo/demo', health: { score: 1 }, metrics: 'FORGED' });
  assert.ok(!seen.groqCalls[0].usr.includes('FORGED')); assert.match(seen.groqCalls[0].usr, /Health score: \d+\/100/);
});
test('IT-09 /summary bad repo -> 400 and no LLM call', async () => {
  seen.groqCalls.length = 0; const r = await post('/summary', { repo: 'nonsense' });
  assert.equal(r.status, 400); assert.equal(seen.groqCalls.length, 0);
});
test('IT-10 /overview caps features at 5  and caches repeat calls', async () => {
  const a = await post('/overview', { repo: 'octo/demo' }); const n = seen.groqCalls.length; const b = await post('/overview', { repo: 'octo/demo' });
  assert.equal(a.json.keyFeatures.length, 5); assert.equal(a.json.usedReadme, true); assert.equal(b.json.cached, true); assert.equal(seen.groqCalls.length, n);
});
test('IT-11 /recommend returns only real repos (hallucinated pick dropped)', async () => {
  const { status, json } = await post('/recommend', { message: 'github analyzer tool', plan: null, shown: [] });
  assert.equal(status, 200);
  const names = json.picks.map((p) => p.fullName);
  assert.ok(!names.includes('fake/hallucinated-repo')); assert.deepEqual(names, ['octo/finder-one', 'octo/finder-two']);
});
test('IT-12 /recommend: vague first message -> clarifying question, no GitHub search', async () => {
  seen.ghPaths.length = 0; seen.groqCalls.length = 0; const { json } = await post('/recommend', { message: 'hi', plan: null, shown: [] });
  assert.equal(json.picks.length, 0); assert.match(json.reply, /what do you want/i); assert.equal(seen.ghPaths.filter((p) => p.includes('search/repositories')).length, 0);
});
test('IT-13 /recommend: already-shown repos are excluded', async () => {
  const { json } = await post('/recommend', { message: 'different ones', plan: { keywords: ['github'], kind: 'tool' }, shown: ['octo/finder-one', 'octo/finder-two'] });
  assert.ok(json.picks.every((p) => !['octo/finder-one', 'octo/finder-two'].includes(p.fullName)));
});
test('IT-14 /recommend empty message -> 400', async () => assert.equal((await post('/recommend', { message: '   ' })).status, 400));
test('IT-15 /recommend truncates message to 500 chars before LLM', async () => {
  seen.groqCalls.length = 0; await post('/recommend', { message: 'x'.repeat(3000), plan: null, shown: [] });
  assert.ok(seen.groqCalls[0].usr.length < 900);
});
test('IT-16 /recommend sanitises forged plan (operators/long strings stripped)', async () => {
  seen.groqCalls.length = 0;
  await post('/recommend', { message: 'more', plan: { keywords: ['react" OR user:victim', 'a'.repeat(100)], language: 'C++; DROP', kind: 'evil' }, shown: [] });
  const prompt = seen.groqCalls[0].usr;
  assert.ok(!prompt.includes('"') || !prompt.includes('user:victim') ); assert.ok(!prompt.includes('DROP'));
});
test('IT-17 missing GROQ_API_KEY -> 503 with setup message', async () => {
  delete process.env.GROQ_API_KEY; const r = await post('/summary', { repo: 'octo/demo' }); assert.equal(r.status, 503); assert.match(r.json.error, /GROQ_API_KEY/);
});
