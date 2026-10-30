# Samsung COMPASS backend

Node.js 24 TypeScript API for SEC authentication, department/account administration, immutable Excel imports and published closing/weekly snapshots. It uses the existing Samsung SEC Supabase project; it does not create a second database.

## Run

Use Node.js 24 and pnpm 10.33.0. Copy `.env.example` to `.env`, set the Supabase URL, publishable and server secret keys, and exact frontend origins. Run `pnpm install --frozen-lockfile` then `pnpm dev` or `pnpm start`.

## Railway

Deploy this repository from its root with the included Dockerfile. Set `HOST=0.0.0.0`, `PORT=4320`, `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and comma-separated exact `FRONTEND_ORIGINS`. The public domain routes to port 4320. Health check: `/api/health` (checks database connectivity). Use one replica: file previews are temporary in-memory state.

Keep the secret key in Railway environment variables only. Normal business queries carry the caller's JWT and use database RLS. Existing SQL migrations in `supabase/migrations` are already applied to the SEC database; deployments do not automatically rerun or reset them.

## Shared Excel definitions

`shared/` contains the exact frontend domain, workbook and column-mapping definitions needed by this standalone backend. Runtime imports use repository-local paths. When changing the import contract, update and verify the corresponding definitions in both frontend and backend repositories.

The importer accepts bounded `.xlsx`/`.xlsm` cached values. It never executes macros, formulas or external links. Known closing presets and the verified HE weekly layout are supported; other layouts need explicit mappings. Errors and missing required values block publication. Weekly values are cumulative dated snapshots and do not generate closing premiums. Admins upload and publish updates; there is no automatic weekly source feed.

The original HA/IM `Result` trackers are also recognized at their Store/SEC/TGT header row. Their EDI period determines the reporting cutoff. These are store totals: an existing unique employee assignment or an explicit person choice is required. Name matching ignores case, separators, accents and name order; only clear fuzzy matches are automatic. Ambiguous or unknown names require review before staging. The selected person and original source identity are stored with the import. New source people require an explicit choice.

Only server-authorized SEC test accounts may request `testMonth`/`testDay` on their own dashboard. This replays historical source stands without changing publication dates, source values, normal accounts or database ownership. The frontend labels the control `Prüfstand`.

## Rolling points and own ranking

`/dashboard` includes `pointHistory`, a minimal monthly projection for the signed-in person's current division across market/setting changes. Duplicate market rows contribute once when their points agree; missing or conflicting point values remain unavailable. Financial reports stay assignment-scoped and premiums remain calendar-year totals.

The private SQL projection is not executable by clients. Scoped invoker wrappers validate the live user/session/current division before returning own point history or an own ranking result. Ranking uses twelve complete monthly person values ending with the selected closing. Peers with incomplete histories are excluded rather than suppressing everyone. The comparison covers the same division, including DA settings, with at least ten complete people. Equal totals share a position. No peer identities, scores or ranks beyond ten are returned. `reason` explains unavailable results; ST has no invented point/rank model.

`tests/rolling-rank.sql` verifies the real SQL permissions, cohort rules, corrections and data boundaries using synthetic fixtures inside a transaction that ends in `ROLLBACK`.

## Checks

`pnpm typecheck` and `pnpm test`. Reader safety/type tests run without private data; original workbook integration cases are skipped when their private source folders are absent. Live API/database acceptance is documented separately and must use the SEC project, never another application's database. No credentials or employee workbooks are included here.

## Isolated presentation accounts

An explicitly configured IM test login receives a wholly synthetic, calendar-aware dashboard with 24 monthly closings and current-month cumulative weekly stands. Its virtual person/market IDs and read markers live only in the private presentation configuration; no people, assignments, imports, reports or weekly business rows are created. The stored login has no employee link, cannot read real SEC rows, and cannot be reassigned to a real employee while presentation configuration exists. Real admin charts and ranking inputs are therefore unchanged.

Presentation dashboard and acknowledgement RPCs validate the live owner/session and dedicated account scope. `tests/presentation-isolation.sql` verifies permissions, durable read markers and isolation inside a transaction ending in ROLLBACK. No presentation credentials belong in this repository.
