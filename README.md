# ANTU MVP

AI Native Travel Product MVP — Sprint 1 / E01 engineering foundation.

## Runtime

- Node.js 24.22.1 LTS, npm 11.19.1 (`.nvmrc` / `.node-version`).
- Next.js 16.4.3 App Router, React 19, TypeScript 5.9, ESLint 9, Vitest 5, Zod 4.
- PostgreSQL 17; Prisma 7.10.1 stable (Prisma 8's current npm tag is a release candidate, so it is deliberately excluded).

ESLint 9.39.5 is pinned because the transitive React/import/accessibility plugins in eslint-config-next 16.4.3 do not declare ESLint 10 compatibility. ESLint 9 emits an upstream end-of-support notice; installation audit currently reports no known vulnerabilities. Revisit this pin when the official Next configuration's complete plugin tree supports ESLint 10.

## Start

```sh
nvm install
nvm use
npm ci
cp .env.example .env
docker compose up -d db
npm run db:check
npm run dev
```

Open http://localhost:3000. `GET /api/health` checks application liveness only; it does not assert database readiness. On this workstation, an isolated Node/npm runtime is also installed under the ignored `.tools/node/` directory; use `export PATH="$PWD/.tools/node/bin:$PATH"` when no system Node is installed.

## Verification

```sh
npm run check
npm run db:check
```

`check` runs Prisma schema validation and client generation, TypeScript, ESLint, Vitest, and a production build. `npm start` serves that build. Database checks need a running PostgreSQL and DATABASE_URL. The Prisma integration test is explicitly skipped when DATABASE_URL is absent; supply it to exercise the real database connection. No paid services or provider keys are required.

The Prisma schema intentionally has no business models or migrations. Prisma 7.10.1 can generate a client for this empty schema; the integration test uses a raw `SELECT 1` through the PostgreSQL adapter. E01 must not invent Trip State, Decision Context, or NAP fields. The PostgreSQL adapter is pinned to the matching Prisma version.

## Source boundaries

`src/app/` contains the bootstrap page and health route; `tests/` contains foundation tests. The pre-existing local Trip State, Decision Context, NAP and PRD documents remain their respective authorities; they have not been copied into this engineering commit or implemented here. The NAP specification is still an engineering review candidate and retains its stated Owner review limits. No business behavior is claimed as implemented.

See `docs/E01-report.md` for actual checks and acceptance status and `docs/cloud-environment.md` for repeatable cloud setup.
