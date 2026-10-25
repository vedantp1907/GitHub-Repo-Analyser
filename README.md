# GitHub Repo Analyser (MERN)

Analyses any public GitHub repository: health score, language mix, commit velocity and contributors.
Results are cached in MongoDB (default 60 min) to protect GitHub's rate limit.

## Run locally
1. Start MongoDB locally, or use a free Atlas cluster.
2. `cp server/.env.example server/.env`, then set `MONGO_URI` (and optionally `GITHUB_TOKEN`).
3. `npm run install:all`
4. Terminal 1: `npm run dev:server` (http://localhost:5000)
5. Terminal 2: `npm run dev:client` (http://localhost:5173)

The app still works without MongoDB, just without caching.

## API
`GET /api/analyse?repo=owner/repo` (a full GitHub URL also works)

`POST /api/overview` with `{ "repo": "owner/repo" }` returns an AI explanation of what the project is (from its README), separate from the metrics-based AI summary.

## Health score (0-100)
Recency 30% | Commit frequency (last 30 days) 30% | Issue resolution ratio 25% | Community (stars + forks, log scale) 15%.
Bus factor = fewest top contributors that make up 50% of commits.

## AI summary (Groq LLM)
`POST /api/summary` with `{ "repo": "owner/repo" }` sends the computed metrics to a Groq-hosted LLM
(default `openai/gpt-oss-120b`) and returns a JSON assessment. Get a free key at https://console.groq.com/keys
and set `GROQ_API_KEY` in `server/.env`. All prompts are in `server/src/prompts.js`.

## Recommendation chatbot
`POST /api/recommend` with `{ "message": "...", "plan": {...} | null, "shown": ["owner/repo"] }`; returns `{ reply, picks, plan }`.
Each chat keeps its own search plan and a list of repos already shown. Chats are stored in the browser's localStorage (key `repo-chats`).

Pipeline (2 Groq calls per message):
1. **Intent (LLM)** updates the chat's plan: core keywords, 3-4 differently-worded search queries, GitHub topic tags,
   the kind of thing wanted (library, app, tool, template, tutorial), language, star floor, and "something like X" references.
2. **Search (GitHub)** runs those queries in parallel (name/description/topics only), merges and de-duplicates them,
   and drops archived, forked, stale (no push in 2 years) and description-less repos. If fewer than 8 candidates remain it
   loosens step by step: topic tags, lower star floor, fewer keywords, then no language filter.
3. **Pre-rank** scores candidates by how many queries found them, GitHub's own order, recent activity and stars.
4. **README excerpts** are fetched for the top 6 so the LLM can see what each repo really does.
5. **Rank (LLM)** picks 3-5 and gives a reason and an honest caveat for each. Picks are validated against the real results,
   so a made-up repo can never reach the user. Repos already shown in the chat are excluded, so "different ones" gives new results.

Set `GITHUB_TOKEN` in `server/.env`: without it GitHub allows only 10 searches a minute and 60 README reads an hour.
Prompts: `INTENT_SYSTEM_PROMPT` and `RANK_SYSTEM_PROMPT` in `server/src/prompts.js`.
