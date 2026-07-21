# Changelog

## [1.0.1](https://github.com/the-mentor/kagent-claude-byo-agent/compare/v1.0.0...v1.0.1) (2026-07-21)


### Bug Fixes

* implement release-please v5 auto-merge via gh cli ([#9](https://github.com/the-mentor/kagent-claude-byo-agent/issues/9)) ([8f049ba](https://github.com/the-mentor/kagent-claude-byo-agent/commit/8f049ba127759742255af870bd6b21f6ac0beeb7))

## 1.0.0 (2026-07-21)


### Features

* add A2A server and entry point ([11d718d](https://github.com/the-mentor/kagent-claude-byo-agent/commit/11d718d58551021defed00844b5dc5de866ec491))
* add agent card and executor ([f302e01](https://github.com/the-mentor/kagent-claude-byo-agent/commit/f302e01b9a6c0f4f92c9eb50f935f8aa9ef45bc1))
* add Dockerfile and Kubernetes manifests ([2c290b6](https://github.com/the-mentor/kagent-claude-byo-agent/commit/2c290b6a4229ef0f080368c6c59ac02d623b53e3))
* emit adk_request_confirmation DataPart for native kagent HITL approval UI ([1d74899](https://github.com/the-mentor/kagent-claude-byo-agent/commit/1d7489940369d55ecb4e85a85f6dcd4c061b68e2))
* implement HITL via canUseTool with ask-once-per-tool semantics ([90fd846](https://github.com/the-mentor/kagent-claude-byo-agent/commit/90fd846e17503c2d7fad3cca9c04fea37be480ff))
* replace console.log with pino structured logging ([c0f7581](https://github.com/the-mentor/kagent-claude-byo-agent/commit/c0f75811df03676f2a8ade49158de7285df7b511))
* replace console.log with pino structured logging ([c0f7581](https://github.com/the-mentor/kagent-claude-byo-agent/commit/c0f75811df03676f2a8ade49158de7285df7b511))
* replace console.log with pino structured logging ([cdba685](https://github.com/the-mentor/kagent-claude-byo-agent/commit/cdba68530f8a07249a5dc7eedbae7aa655cd8686))
* Substrate session persistence for SandboxAgent actors ([#2](https://github.com/the-mentor/kagent-claude-byo-agent/issues/2)) ([67a2ac4](https://github.com/the-mentor/kagent-claude-byo-agent/commit/67a2ac4de6fb662092f7c98699434bd18cb2a46d))


### Bug Fixes

* add shebang+exec to entrypoint script, set +x, update k8s cmd ([24891c8](https://github.com/the-mentor/kagent-claude-byo-agent/commit/24891c83c6202e308b1fe9d0936e43573ec303e8))
* listen on port 80 (kagent readyz checks port 80, not 8080) ([80a187b](https://github.com/the-mentor/kagent-claude-byo-agent/commit/80a187bb850e1ec2c1631543d9e999e70c6c8786))
* persist tasks to kagent and deliver HITL responses exactly once ([#4](https://github.com/the-mentor/kagent-claude-byo-agent/issues/4)) ([f38cd5f](https://github.com/the-mentor/kagent-claude-byo-agent/commit/f38cd5f0af96b93409a87aa5a653951aab4cd8b5))
* publish Task event before status/artifact updates for message/send ([f616ca0](https://github.com/the-mentor/kagent-claude-byo-agent/commit/f616ca07dcac31adba17fb97a62794014849127e))
* resolve build and test issues ([d0b52d3](https://github.com/the-mentor/kagent-claude-byo-agent/commit/d0b52d37a219918a21e54c5d7fd8b85d1b545a63))
* stream text as status-update working events so kagent UI displays responses ([7802391](https://github.com/the-mentor/kagent-claude-byo-agent/commit/7802391ffaa00c9d3eb0d6795d85c1fe7371558d))
* use absolute path in entrypoint to avoid cwd-dependent resolution ([74cbb1e](https://github.com/the-mentor/kagent-claude-byo-agent/commit/74cbb1ea812a9f4b8538a60963b816fbcb953f6e))
* use adk_ prefix on DataPart metadata keys for HITL confirmation ([c72436c](https://github.com/the-mentor/kagent-claude-byo-agent/commit/c72436c80ba69ad1e14eb365b9dcfed5438121e6))
