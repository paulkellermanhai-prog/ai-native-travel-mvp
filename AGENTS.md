# ANTU engineering scope

E01 is infrastructure only: Next.js/TypeScript, dependency management, configuration, database tooling, tests and build verification. Stop after E01 for technical-lead review. Do not implement Trip State, Decision Context or NAP business fields, transitions, permissions or rules without the approved source contracts and a separately authorized task.

Use Node.js 24.22.1 and npm 11.19.1. Run `npm ci`, `npm run check`, and, when PostgreSQL is available, `npm run db:check`. Set DATABASE_URL to run the Prisma integration test; it is explicitly skipped without that variable. Tests must verify behavior and failure cases. `/api/health` is liveness, not database readiness. Do not invent a database model to satisfy Prisma generation.

Before editing, state assumptions and tradeoffs. Use the simplest solution that meets the task. Make surgical changes, preserve unrelated work, and report actual checks and limitations. The E02 handoff is at specs/README.md with byte-preserved source files and a SHA-256 manifest. Trip State 0.1.0 remains a development baseline pending Owner confirmation; DC/NAP review and path/version issues remain recorded. Run npm run specs:verify. Copied reference Python is not application implementation. The current scope permits E01 CI, source handoff and an E02 plan only; stop for technical-lead review before business coding.

Keep secrets, `.env`, generated clients, dependency trees, local tools and PostgreSQL data out of commits. Use working branches and pull requests; do not change repository security settings or merge without technical-lead acceptance.
