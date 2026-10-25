const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Module 2: Language composition
export function languageStats(languages) {
  const total = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(languages)
    .map(([name, bytes]) => ({ name, bytes, percent: +((bytes / total) * 100).toFixed(1) }))
    .sort((a, b) => b.bytes - a.bytes);
}

// Module 3: Commit activity & velocity
export function commitStats(commits) {
  const now = Date.now();
  const perDay = {};
  const perAuthor = {};
  const weekday = Array(7).fill(0);
  let last30 = 0;

  for (const c of commits) {
    const date = c.commit?.author?.date;
    if (!date) continue;
    const d = new Date(date);
    const key = d.toISOString().slice(0, 10);
    perDay[key] = (perDay[key] || 0) + 1;
    weekday[d.getUTCDay()]++;
    const author = c.author?.login || c.commit.author.name || 'unknown';
    perAuthor[author] = (perAuthor[author] || 0) + 1;
    if (now - d.getTime() <= 30 * 864e5) last30++;
  }

  const timeline = [];
  for (let i = 89; i >= 0; i--) {
    const key = new Date(now - i * 864e5).toISOString().slice(0, 10);
    timeline.push({ date: key, commits: perDay[key] || 0 });
  }
  const authors = Object.keys(perAuthor).length;
  return {
    sampled: commits.length,
    last30,
    activeAuthors: authors,
    avgPerAuthor: authors ? +(commits.length / authors).toFixed(1) : 0,
    weekday: weekday.map((count, i) => ({ day: DAYS[i], count })),
    peakDay: commits.length ? DAYS[weekday.indexOf(Math.max(...weekday))] : '-',
    timeline,
  };
}

// Module 4: Contributor insights
export function contributorStats(list) {
  const total = list.reduce((a, c) => a + c.contributions, 0) || 1;
  let running = 0;
  let busFactor = 0;
  for (const c of list) {
    running += c.contributions;
    busFactor++;
    if (running / total >= 0.5) break;
  }
  return {
    busFactor: list.length ? busFactor : 0,
    top: list.map((c) => ({
      login: c.login,
      avatar: c.avatar_url,
      url: c.html_url,
      contributions: c.contributions,
      share: +((c.contributions / total) * 100).toFixed(1),
    })),
  };
}

// Module 1: Health score (0-100), weighted blend
export function healthScore({ info, commits, openIssues, closedIssues }) {
  const daysSincePush = (Date.now() - new Date(info.pushed_at).getTime()) / 864e5;
  const recency = clamp(100 - daysSincePush * (100 / 180));
  const frequency = clamp((commits.last30 / 30) * 100);
  const totalIssues = openIssues + closedIssues;
  const resolution = totalIssues ? (closedIssues / totalIssues) * 100 : 70;
  const community = clamp(Math.log10(info.stargazers_count + info.forks_count + 1) * 25);

  const parts = [
    { label: 'Recency', score: Math.round(recency), weight: 0.3 },
    { label: 'Commit frequency', score: Math.round(frequency), weight: 0.3 },
    { label: 'Issue resolution', score: Math.round(resolution), weight: 0.25 },
    { label: 'Community', score: Math.round(community), weight: 0.15 },
  ];
  const score = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0));
  const grade = score >= 80 ? 'Excellent' : score >= 60 ? 'Healthy' : score >= 40 ? 'Fair' : 'Needs attention';
  return { score, grade, breakdown: parts };
}
