# Codex cloud environment

Repository: `paulkellermanhai-prog/ai-native-travel-mvp` (private).

The initial README commit establishes `refs/heads/main`. E01 code is reviewed on `chore/e01-engineering-bootstrap`; main remains the initial README until the technical lead accepts and merges the PR. Do not represent a README-only checkout as the tested E01 application.

After the engineering PR is merged, configure Node 24.22.1 and npm 11.19.1, then run `npm ci` and `npm run check` from the repository root. Use a local PostgreSQL 17 service in the cloud VM, set DATABASE_URL there, and run `npm run db:check`; no hosted paid database is required. Linux dependencies for Prisma include OpenSSL, zlib and standard C libraries.

The actual setup VM is Debian 13 amd64. Runtime tools are installed without root under `/workspace/.e01-runtime`; each shell must source `/workspace/.e01-runtime/activate.sh`. Verified versions: Node 24.22.1, npm 11.19.1, Git 2.52.0 and PostgreSQL 17.11. PostgreSQL uses the regular `agent` OS role, database `postgres`, a private Unix socket at `/workspace/.e01-runtime/socket`, peer authentication and no TCP listener. Node downloads are checked against official SHA256 values; PostgreSQL packages come from signed Debian metadata. Installation, restart and repeated startup were tested. The install script and start instructions are saved in the cloud environment configuration, outside the Git repository.

For this cloud database (distinct from the Docker development example):

```sh
source /workspace/.e01-runtime/activate.sh
export DATABASE_URL='postgresql://agent@localhost/postgres?host=%2Fworkspace%2F.e01-runtime%2Fsocket'
npm run db:check
```

Recommended install commands:

```sh
node --version
npm --version
git --version
npm ci
npm run db:validate
```

Allow npm package downloads and any Prisma engine download domain actually required by the installation. Save and publish only after setup and database readiness checks succeed. Configuration files in this repository alone do not prove that a cloud environment has been published.
