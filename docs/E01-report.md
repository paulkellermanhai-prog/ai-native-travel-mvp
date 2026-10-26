# ANTU Sprint 1 / E01 engineering report

Date: 2026-10-26 (Asia/Shanghai). Status: engineering verification in progress; technical-lead acceptance pending.

## GitHub and source control

- Actual authenticated account/repository: `paulkellermanhai-prog/ai-native-travel-mvp`. The spelling `paulkellermaanhai-prog` in the request differs from both the authenticated login and existing origin; no second repository was created.
- Private repository retained. GitHub connector reports push/admin permissions. Initial README commit: `374878e01d16b6270983180f036d96d99a3d95cd` on `main`.
- `git ls-remote origin refs/heads/main` returned that commit; `git fetch origin main` succeeded. This resolves the original missing-main checkout error.
- Engineering work uses `chore/e01-engineering-bootstrap`. Main is left for technical-lead review and PR merge; repository security settings were not modified.
- Local `gh auth status` still reports its old token invalid, but authenticated Git fetch and the GitHub connector both work. No token or password was requested or exposed.

## Created engineering files

- `src/app/`: minimal home page, layout, CSS and `/api/health` liveness route.
- `src/lib/env.ts`, `tests/`: PostgreSQL URL validation, liveness test and opt-in real Prisma/PostgreSQL integration test.
- `prisma/schema.prisma`, `prisma.config.ts`, `scripts/db-check.mjs`, `compose.yaml`: empty business schema, stable ORM configuration, real SQL connectivity probe and local PostgreSQL Docker option.
- `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`: reproducible dependency/build/test configuration.
- `.gitignore`, `.env.example`, `.npmrc`, `.nvmrc`, `.node-version`, `AGENTS.md`, `README.md`, `docs/`: environment, scope and handoff guidance.
- Existing PRD, Trip State, Decision Context and NAP local source folders were inspected and preserved. No conflicting framework requirement was found. They are not added to this infrastructure commit. Future business work needs those approved sources; the NAP package states it is a review candidate, not Owner-approved production implementation.

## Actual versions

| Component | Verified version |
| --- | --- |
| Node / npm | 24.22.1 LTS / 11.19.1 |
| Git, local / cloud | 2.50.1 / 2.52.0 |
| Next.js / React | 16.4.3 / 19.3.1 |
| TypeScript / Vitest / Zod | 5.9.3 / 5.0.5 / 4.6.7 |
| Prisma CLI, client, pg adapter | 7.10.1 (matching stable versions) |
| pg / dotenv | 8.23.1 / 17.4.2 |
| ESLint / Next ESLint configuration | 9.39.5 / 16.4.3 |
| PostgreSQL, actual cloud service | 17.11 (Debian 13 amd64) |

ESLint 10 was tested but rejected after full dependency-tree inspection showed incompatible peer declarations in Next's transitive plugins. ESLint 9 is pinned for a valid dependency tree. It emits an upstream end-of-support/deprecation notice; npm audit reported 0 known vulnerabilities. This is a recorded maintenance caveat, not a hidden successful upgrade. Prisma 8's npm tag resolves to a release candidate, so the stable 7.10.1 line was selected.

## Actual verification so far

| Check | Result |
| --- | --- |
| npm install / audit | Passed; 0 known vulnerabilities |
| Full `npm ls --all` | Passed with the final ESLint 9 tree |
| Prisma validate / generate | Passed with zero business models |
| TypeScript | Passed |
| ESLint | Passed with `--max-warnings 0` |
| Local Vitest | 6 passed; 1 database integration test explicitly skipped because local DATABASE_URL is unset |
| Local production build | Passed; home, not-found and health routes compiled |
| Local production HTTP smoke | `/` and `/api/health` both returned 200; home content and health JSON asserted |
| Cloud PostgreSQL | `SELECT 1 = 1`; restart and repeated startup passed |
| Cloud runtime install | Repeated installation passed; no root or paid hosted service required |

Cloud application checks, published environment status and the PR will be recorded after the engineering branch is pushed and checked there. The cloud install/start draft currently contains verified runtime preparation under `/workspace/.e01-runtime`; it is not yet published. The local Mac runtime is isolated under ignored `.tools/node/`; no system Node or Docker/PostgreSQL was preinstalled. Local TCP startup needed an execution-sandbox permission grant; no source workaround was introduced.

## Acceptance boundary

No Trip State, Decision Context or NAP business implementation, schema fields or rules were invented. No migrations, user data, provider keys, hosted paid resources or security-setting changes were introduced. E01 must stop for technical-lead review after infrastructure verification and PR delivery. Passing automated checks is not technical-lead acceptance and not production readiness.

## Official references

- [Codex Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments): installation/start configuration and save/publish lifecycle.
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation): application/tooling requirements.
- [Prisma 7 system requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements): Node 24 compatibility.
