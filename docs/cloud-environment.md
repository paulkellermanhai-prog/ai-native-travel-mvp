# Codex cloud environment

Repository: `paulkellermanhai-prog/ai-native-travel-mvp` (private).

The initial README commit establishes `refs/heads/main`. E01 code is reviewed on `chore/e01-engineering-bootstrap`; main remains the initial README until the technical lead accepts and merges the PR. Do not represent a README-only checkout as the tested E01 application.

Environment `ai-native-travel-mvp` has been published with Only me visibility after validation of the engineering branch at `4cb679902903407aaf00c0910b6c719ff1423e05`. The published environment has Node 24.22.1, npm 11.19.1, locked application dependencies and a local PostgreSQL 17 service. Fresh-task snapshot restoration is not separately verified. After the PR is accepted and merged, future main checkouts can use the same tooling; before then, the runnable source is on the engineering branch. Linux dependencies for Prisma include OpenSSL, zlib and standard C libraries.

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

The restricted network configuration uses the package-manager preset plus `binaries.prisma.sh` for official Prisma engine downloads. The first request to that checksum URL returned 403; after saving the added domain it returned 200 and full validation succeeded, without bypassing checksums or TLS. Save and publish only after setup and database readiness checks succeed. Configuration files in this repository alone do not prove that a cloud environment has been published.
