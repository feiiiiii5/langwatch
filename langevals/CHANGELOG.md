# Changelog

## [2.3.0](https://github.com/langwatch/langwatch/compare/langevals@v2.2.0...langevals@v2.3.0) (2026-07-11)


### Features

* **experiments-v3:** pairwise compare end-to-end with winner-by-id label ([#5142](https://github.com/langwatch/langwatch/issues/5142)) ([5964a2f](https://github.com/langwatch/langwatch/commit/5964a2f02f9175dd4d64125786f97556fdb0b116))
* **pairwise-compare:** support comparing A vs B without a golden/reference answer ([#5381](https://github.com/langwatch/langwatch/issues/5381)) ([8d58404](https://github.com/langwatch/langwatch/commit/8d584040e34d402df23a2fe391f20a2e79662b41))


### Bug Fixes

* **deps:** close 6 langevals security alerts with minimal stable bumps ([1467908](https://github.com/langwatch/langwatch/commit/14679085c750c94f7b583ca7479b4e76cc58ff23))
* **deps:** close 6 langevals security alerts with minimal stable bumps (no prerelease, no downgrade) ([#4654](https://github.com/langwatch/langwatch/issues/4654)) ([1467908](https://github.com/langwatch/langwatch/commit/14679085c750c94f7b583ca7479b4e76cc58ff23))
* **deps:** close langevals transformers and strawberry-graphql security alerts ([#4656](https://github.com/langwatch/langwatch/issues/4656)) ([50b3250](https://github.com/langwatch/langwatch/commit/50b32501a58165a75286024e1901c3f22862151c))
* **deps:** uv security sweep across langevals, mcp-server, python-sdk ([#4687](https://github.com/langwatch/langwatch/issues/4687)) ([7eba1fb](https://github.com/langwatch/langwatch/commit/7eba1fbec1cf01b7929b35529c41f5b089070263))
* **security:** bump hono&gt;=4.12.25 and langsmith&gt;=0.8.18 ([5dd4178](https://github.com/langwatch/langwatch/commit/5dd41782beee86ce4333c255d0914357a4e9716d))
* **security:** bump hono&gt;=4.12.25 and langsmith&gt;=0.8.18 (Dependabot [#1500](https://github.com/langwatch/langwatch/issues/1500), [#1516](https://github.com/langwatch/langwatch/issues/1516)) ([#5211](https://github.com/langwatch/langwatch/issues/5211)) ([5dd4178](https://github.com/langwatch/langwatch/commit/5dd41782beee86ce4333c255d0914357a4e9716d))
* **security:** bump Python infra deps (cryptography, tornado, python-multipart, aiohttp) ([#4873](https://github.com/langwatch/langwatch/issues/4873)) ([7488bc5](https://github.com/langwatch/langwatch/commit/7488bc5a088ce12c2de13f1a2472afc1b9bdb6a4))
* **security:** bump starlette to 1.3.1 across uv workspaces ([#5019](https://github.com/langwatch/langwatch/issues/5019)) ([dc03945](https://github.com/langwatch/langwatch/commit/dc0394579b59f2f4a81da283f34a6478a501b1b0))
* **security:** raise langevals pydantic-settings transitive floor ([#5611](https://github.com/langwatch/langwatch/issues/5611)) ([6411587](https://github.com/langwatch/langwatch/commit/64115872d56ea953fdf1a4afd44882509a1759a3))


### Code Refactoring

* **types:** make zod the single source of truth, remove ts-to-zod ([#4651](https://github.com/langwatch/langwatch/issues/4651)) ([d583fbe](https://github.com/langwatch/langwatch/commit/d583fbe2ed2ca2ef320695323c17f6c362ea4efa))
