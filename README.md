# ANTU MVP

AI Native Travel Product MVP — Sprint 1 / E01 engineering foundation.

中文阅读入口：[工程目录与保留说明](docs/工程目录与保留说明.md)。本机工程已集中存放于 `MVP Engineering/`；运行下面的命令前，请先进入这个工程文件夹。GitHub/云端检出时直接使用仓库根目录，无需另建同名子目录。

此前实际验收：[2026-10-27 E01 验收复核](docs/E01验收复核-2026-10-27.md)。[规格读取基线](docs/specification-baseline.json)保留当时本地四份资料的版本、摘要、审核状态与路径差异；它是历史检查记录。

最新 E01 收尾：[CI、新云任务与规格交接验收](docs/E01收尾与E02交接-2026-10-27.md)、[云端可读的版本化规格](specs/README.md)、[E02 最小编码任务](docs/E02最小编码任务.md)。此前的本地读取清单保留为历史检查；当前源码交接以 specs 的 manifest 为准，候选批准状态未改变。

E01 至 E02-04C 已经技术负责人验收；PR #1–#7 已合并。Owner 已确认 Trip State 0.1.0 开发基线；当前切片为 [E02-04D 重算、采用与问题处理](docs/E02-04D验收.md)，完成后停止审核，不自行宣布 E02 PASS。E02-05 的真实认证、HTTP 与完整端到端验收尚未实现；原规格快照保持不变。

此前验收：[E02-01 契约](docs/E02-01验收.md)、[E02-02 持久化](docs/E02-02验收.md)、[E02-03 七步场景](docs/E02-03验收.md)、[E02-04A 确认机制](docs/E02-04A验收.md)、[E02-04B 生命周期](docs/E02-04B验收.md)、[E02-04C 外部事实](docs/E02-04C验收.md)。内部命令通道要求宿主注入真实授权结果；当前没有生产身份适配器或公开业务写入 HTTP 路由。合成存储写入口仍仅供隔离测试。

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

Prisma contains four infrastructure tables for original Trip State JSONB, append-only history, pending proposals and idempotency. Runtime and migration identities are separate. See the E02-02 report for database provisioning; set E02_STORAGE_ENV_FILE to a private provisioning result to execute all storage and command integration tests. CI provisions a genuinely empty PostgreSQL 17 database and forbids skipping these tests. The PostgreSQL adapter is pinned to the matching Prisma version.

## Source boundaries

`src/app/` contains the bootstrap page and health route; `tests/` contains foundation tests. Byte-preserved authoritative PRD and Trip State/DC/NAP snapshots are versioned under specs/ with a SHA-256 manifest. The TypeScript implementation executes all twelve original command operations and complete A–G scenarios. Real host identity integration, business HTTP and full end-to-end acceptance remain E02-05 work. Python runs only as an independent test oracle. The NAP/DC specifications retain their review limits and unresolved issues; their runtime modules are not implemented.

See `docs/E01-report.md` for actual checks and acceptance status and `docs/cloud-environment.md` for repeatable cloud setup.
