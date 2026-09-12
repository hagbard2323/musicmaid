# Roadmap

The immediate goal is a reliable **single-community self-hosted beta**, followed
by evidence for a stable release. This is a priority order, not a release-date
promise. Implemented behavior is documented in the [member guide](COMMUNITY-BETA.md);
completed tests and open acceptance are in [Validation](VALIDATION.md).

## Before calling it stable

1. Have independent operators install with their own applications/accounts using
   only the maintained guide. Resolve the steps that require hidden knowledge.
2. Run extended listening and regression requests across enabled sources. Measure
   first-choice correctness, startup delay, interruptions and recovery results.
3. Validate member/mobile controls, older-card navigation, shared queues and
   playlist portability in real Discord clients.
4. Keep release/build identity, backup and restore usable and rehearsed. Make
   account repair and provider cooldowns clear enough to avoid ineffective restarts.
5. Complete source/asset provenance, private security reporting and operator data
   handling for each distributed release.

## Improvements after acceptance

- Refine source error categories and recovery messages around evidence from real failures.
- Improve per-member work budgets, load visibility and persistence efficiency when measured use justifies it.
- Simplify controls through member testing, preserving explicit correction and separate navigation.
- Evaluate additional audio sources for recording identity, access conditions,
  maintained integrations and testability before adding buttons or promises.
- Broaden installation support only after testing a specific distribution/architecture and recovery path.

## Deferred proposals

**Release Radar:** opt-in artist follows and weekly saved playlists, with
remaster/reupload deduplication and member-started listening. Automatic discovery,
release posts and listening parties are not implemented.

**Voice requests:** a possible convenience/accessibility feature, requiring clear
consent, command authorization, ambiguity correction and defined audio retention.
No voice-command capture or recognition is implemented by this beta. The normal
Add music interaction remains the supported request path.

**Hosted or commercial operation:** a separate product/design exercise. Shared
guild administration, account isolation, quotas, service monitoring, data lifecycle,
support and provider permissions need their own acceptance. The source license
does not establish readiness to sell or operate a shared service.
