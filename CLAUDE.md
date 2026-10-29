# CLAUDE.md - Trippy

Trippy is an AI decision layer on top of map data: a passenger describes what they need ("dad is hungry, something similar within 20 minutes") and Trippy finds real places along the route, weighs the trade-off and shows the best 3. Built for the Nebius x NVIDIA Global AI Hackathon (track Best Apps and Agents). Deadline 2026-10-30 10:00 PDT.

## Where the design lives
The design bus is in the private GitHub repo `DarthRoco/artifact-bus`, folder `trippy/` (also mirrored to the claude.ai Project "Trippy"). It is cloned next to this repo at `../artifact-bus/`, so the bus is `../artifact-bus/trippy/`.
- At the start of every session: `git -C ../artifact-bus pull`, then read `../artifact-bus/trippy/INDEX.md`, then `DECISIONS.md`, then `BUILD-PLAN.md`.
- `DECISIONS.md` wins any conflict with other files or with this one.
- `DESIGN.md`: tools, state shapes, context block, architecture, code layout, week-1 test.
- `FEATURES.md`: MUST / SHOULD / LATER and the demo script.
- `BUILD-PLAN.md`: day-1 checks and week-by-week tasks.
- `TESTSET.md`: the requests every build must handle (43 so far).
- `REJECTED.md`: do not revive these.

## Stack
- Monorepo: `packages/core` (tool schemas + implementations, provider interface, buildContext, types), `apps/web` (PWA), `apps/proxy` (backend), `traces/` (GPS traces for replay).
- Web: Vite + React + TypeScript, vite-plugin-pwa, @vis.gl/react-google-maps, IndexedDB.
- Backend: stateless. `/maps` (Google key), `/search` (Tavily key), `/llm` (Nebius key). Hosted on Cloudflare: the proxy on Workers, the PWA on Pages.
- Models: Nemotron on Nebius Token Factory (OpenAI-compatible). Super (reasoning off) picks tools; Ultra (reasoning off) ranks; Ultra with reasoning for planning mode. Model per call type lives in one config object.

## Rules
- The model never invents places. Every suggestion comes from a real provider lookup.
- Code writes all state. The model changes state only through `remember` and `forget`.
- No user data on the backend. The relay does not store or log.
- No API keys in the repo or in client code, except the domain-restricted browser map key. Keys come from env.
- Every Places call uses a field mask with only the fields needed.
- Tools are code functions with JSON schemas in `packages/core`; the agent loop only executes what the model asks for.
- License file stays in the repo root (hackathon requirement).

## Keeping the bus current
- Code lives in this repo. Decisions and plan state live in the bus.
- When a task in BUILD-PLAN.md finishes, tick it there.
- `DECISIONS.md` holds only what is decided now. When something is decided, add one dated line in its topic section and update the affected file (DESIGN.md, FEATURES.md). When a decision changes, edit its line and append the old wording, dated, to `archive/DECISIONS-LOG.md`. Never read the archive on resume.
- At the end of a session: update INDEX.md "This turn" (did / next) and `updated`, then commit and push `../artifact-bus` with a message starting `trippy:`.
- Never put keys, .env contents or credentials in the bus.

## Parallel streams (from 2026-10-04)
Work runs as stream sessions (one letter each) plus one lead session. BUILD-PLAN.md lists each stream's scope, owned files, tests and done criteria.
- A stream works in its own git worktree and branch off `main`, and edits only the files its section owns. A change outside them (shared types, `agent.ts`, another stream's files) goes in the PR description as a request to the lead.
- A stream may add lines to `DECISIONS.md`. It does not edit INDEX.md or BUILD-PLAN.md; the lead does, at merge.
- The user's test runs are logged to `logs/trip-<start>.jsonl` (newest = latest run) when the local proxy is running; read them before asking the user to describe a bug.
- A stream ends with a PR whose description is the handoff: what changed, how it was checked, what is open.
- Testing costs credits: run only the few TESTSET ids a change could break. A full TESTSET run only when the user says so. Merges belong to the lead.
- Dev ports: lead / C on 5173, A on 5174, B on 5175 (`npm run dev -w apps/web -- --port 5174`, or the `web-a` / `web-b` launch entries). One proxy on 8787 serves all; C tests its own proxy changes with `PORT=8788`. Each worktree needs its own `.env` copy and `npm install`.
