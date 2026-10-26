# ANTU engineering scope

E01 is infrastructure only: Next.js/TypeScript, dependency management, configuration, database tooling, tests and build verification. Stop after E01 for technical-lead review. Do not implement Trip State, Decision Context or NAP business fields, transitions, permissions or rules without the approved source contracts and a separately authorized task.

Use Node.js 24.22.1 and npm 11.19.1. Run `npm ci`, `npm run check`, and, when PostgreSQL is available, `npm run db:check`. Set DATABASE_URL to run the Prisma integration test; it is explicitly skipped without that variable. Tests must verify behavior and failure cases. `/api/health` is liveness, not database readiness. Do not invent a database model to satisfy Prisma generation.

Before editing, state assumptions and tradeoffs. Use the simplest solution that meets the task. Make surgical changes, preserve unrelated work, and report actual checks and limitations. The local project contains pre-existing specification folders outside this E01 Git commit; retrieve approved specifications before future business development.

Keep secrets, `.env`, generated clients, dependency trees, local tools and PostgreSQL data out of commits. Use working branches and pull requests; do not change repository security settings or merge without technical-lead acceptance.
