# ANTU engineering scope

E02 Final Engineering Gate PASS: PR #9 approved at exact head 98fd3236eb87d2c11977e8d8793d5117440857ce, merged as 6ae8b2b66513c51ff209ce7147e8c6ff7376a39b; main push CI 40813876620 passed before E02 closed (docs/E02-final-gate.json). Current authorization: E03-01 accepted at PR #14 head 213b274a0de35bb369caa750bbc09fa809735a83 by the project technical review recorded in docs/e03-01-technical-acceptance.json; E03-02 accepted at PR #18 exact head 9b92c1c0c9b5ffcfca468ddf9cc6c7baec69f911 by E03-02-PR18-TECH-ACCEPTANCE-2026-11-06-01, recorded in docs/e03-02-technical-acceptance.json; E03-00 through E03-02 accepted planning weight is 33%. Acceptance covers the internal Session-bound read-only Context assembly/consumption only. CI #65 attempt 1 P05 connection-close root cause remains unknown; attempt 2 passed at the same head, not a demonstrated fix. E03-03 有限并行例外：
依据工程主会话技术决定
E03-03-PARALLEL-SCOPE-2026-11-06-01，
允许在独立 worktree/分支中实现 E03-03-1、E03-03-2 的有限部分：
复用冻结 R6 的正式结构化输入合同、现有生成类型和严格校验器；
新增不依赖完整 Context/Packet 的纯任务身份、关联、焦点及
原规则可独立判定的进度/证据守卫，并编写合成测试。

本有限并行授权本身不构成阶段验收，也不等于整个 E03-03 已放行。
E03-02 已在上述后续独立回执中验收，E03 已验收规划权重为33%。

实施起点固定为
33059d42de0a08e3a5a1e072b0e7e99d2af043ff，
先由 E03-02 主实施与集成执行者落盘本决定及文件责任，
再开展代码工作。允许路径与证据要求见
docs/E03-03有限并行授权-2026-11-06.md。

新增模块必须保持未接入生产调用链。
只允许测试目录中的合成数据和依赖桩；
不得以合成输入证明真实授权、生产 Task 归属、E11 来源、
Packet 完整交付或事实消费时效。
依赖未完成时不得默认通过或伪造完整 Packet/Grant。

除该有限例外外，继续禁止实施 E03-03 的其他部分及 E03-04–07：
生产 Turn/Task 服务、Context 依赖的分页和消费时效链、
生产 E11 采集/关联/读取/保留/删除、Checkpoint、
业务读写与确认桥接、NAP 和 UI。
复用既有合同不授权新增字段、URI、枚举、版本或权限。
保持冻结来源、R6 默认和原 Gate 历史，不自动合并或部署。 Preserve 155 original files, historical Gate records, frozen R6 selection and package bytes; use R6 default. UX-02 PR #13 remains separate; its R7 rules received limited specification/reference acceptance but are not silently integrated. Preserve #10→#12→#14 and #11→#13 histories; do not merge or deploy. Formal product, contract, permission or version changes require the appropriate review.

Use Node.js 24.22.1 and npm 11.19.1. Run `npm ci`, `npm run check`, and `npm run db:check`. CI provisions a disposable PostgreSQL 17 test database using scripts/prepare-storage-tests.mjs; E02_STORAGE_ENV_FILE is a private file outside Git containing distinct migration/runtime connections. Storage integration tests may not skip in CI. Tests must verify behavior and failure cases. `/api/health` is liveness, not database readiness. Database tables are infrastructure around original JSON contracts, not new business objects.

Before editing, state assumptions and tradeoffs. Use the simplest solution that meets the task. Make surgical changes, preserve unrelated work, and report actual checks and limitations. The E02 handoff is at specs/README.md with byte-preserved source files and a SHA-256 manifest. The separate specs/trip-state-development-baseline.json records Owner confirmation; do not alter immutable source snapshot metadata. DC/NAP review and path/version issues remain recorded. Run npm run specs:verify and npm run contracts:check. Copied reference Python is an independent test oracle, not application implementation. Tests require Python dependencies in scripts/requirements-oracle.txt and TRIP_STATE_PYTHON when using a virtual environment; CI installs them automatically.

Keep secrets, `.env`, generated clients, dependency trees, local tools and PostgreSQL data out of commits. Use working branches and pull requests; do not change repository security settings or merge without technical-lead acceptance.
