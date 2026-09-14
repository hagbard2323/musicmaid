# Changelog

## 0.1.0-beta.2 — 2026-09-14

Security maintenance for the optional Rust Spotify helper. Application behavior
is unchanged; beta.1 limitations carry over.

- Resolved four advisories against rustls-webpki 0.102.8 (GHSA-82j2-j2ch-gfr8,
  GHSA-pwjx-qhcg-rvj4, GHSA-xgp8-3hg3-c2mh, GHSA-965h-392x-2mh5), reached only
  through hyper-proxy2 0.1.0's pinned rustls 0.22. The connector is now vendored
  under `apps/spotify-stream/vendor/hyper-proxy2` (upstream commit
  `2a1a9845f4c9a100c45bf3dc0f1222773d5a33b7`, MIT, sources unchanged, manifest
  adjusted) via `[patch.crates-io]`, so the helper builds one rustls 0.23 /
  rustls-webpki 0.103 stack; the unmaintained rustls-pemfile drops out. That
  TLS path is used only with a configured HTTPS proxy, which the helper never
  sets. A regression test builds the HTTP/TLS client configuration without
  network I/O, guarding against a second rustls crypto provider. rustls itself
  moves to 0.23.45 (RUSTSEC-2026-0285, TLS 1.3 handshake messages accepted
  across encryption-level boundaries).
- New CI job **Optional Spotify helper / RustSec advisories** runs pinned
  cargo-audit 0.22.2 against the locked helper tree on every push and pull
  request. Vulnerabilities fail the job; accepted advisories and their reasons
  live in `apps/spotify-stream/.cargo/audit.toml`.
- `apps/spotify-stream/vendor` is part of the release source hash in
  `release-manifest.mjs` and the self-host installer.
- Dependabot updates merged: tsx 4.23.13 (development) and ws 8.21.3, which is
  also the WebSocket library behind the Discord gateway and Lavalink clients.
  Major updates of `@types/node` (tracks the oldest supported Node 22) and
  `dotenv` (v17 startup logging) are ignored until adopted deliberately.
- Operators: the self-host update flow does not rebuild the helper. After
  updating, re-run the Sources step for Original Spotify audio to rebuild and
  verify it; otherwise the installed binary keeps the previous library versions.

## 0.1.0-beta.1 — 2026-09-13

First source release for one self-hosted Discord community per installation.
This is a beta; independent installation, sustained listening and real mobile
acceptance remain open. See [validation](docs/VALIDATION.md).

- Recording-aware selection, automatic clear matches, explicit version review,
  same-recording retries, and early-finish detection.
- Durable playback sessions, FIFO or requester-fair queues, retained queue
  selection during edits, saved playlists, portable imports and request charts.
- Full controls on Now playing and compact historical cards with private current
  controls; optional synchronized YouTube viewer with independent voice audio.
- Moderator diagnosis, redacted diagnostic downloads, repair, confirmed service
  restarts and an external process watchdog.
- One-community startup and interaction enforcement, scoped saved-session reads,
  transactional failure handling and bounded database lock waits.
- Guided AlmaLinux 10 x86_64 installation, optional integrations, matched backups,
  update/rollback and preview-first manual request-statistics cleanup.
- Seeded state-machine regressions, source/viewer cancellation and overload
  fixtures, and a separate bounded full-queue stress command.
- MIT source/artwork, public setup and architecture guides, dependency locks,
  private security-reporting guidance and fixture provenance.

Voice requests, Release Radar and a shared hosted service are not part of this
release. Provider access and media rights are separate from the code license.
