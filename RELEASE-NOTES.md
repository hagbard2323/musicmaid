MusicMaid 0.1.0-beta.2 is a security-maintenance release for the optional Rust
Spotify helper. Four Dependabot advisories against rustls-webpki 0.102.8 were
reachable only through hyper-proxy2 0.1.0's pinned rustls 0.22; that connector
is now vendored under `apps/spotify-stream/vendor` (upstream sources unchanged,
MIT retained) so the helper builds a single rustls 0.23 / rustls-webpki 0.103
stack. The affected TLS path is used only with a configured HTTPS proxy, which
the helper never sets. CI now audits the helper's locked dependencies against
the RustSec database with pinned cargo-audit, the vendored copy is part of the
release source hash, rustls moves to 0.23.45 (RUSTSEC-2026-0285), and the tsx
and ws dependencies were updated. Application behavior is unchanged; see
`CHANGELOG.md`.

Operators who enabled original Spotify audio: the update flow does not rebuild
the helper. After `./scripts/setup.sh update`, run `./scripts/setup.sh sources`
and repeat the **Original Spotify audio** step to rebuild and verify it.
Otherwise the installed binary keeps the previous library versions.

Validation: the application regressions on Node 22 and 24, the installer
fixtures, the locked Rust helper build and tests, and the RustSec audit pass.
The limitations recorded for beta.1 carry over: independent fresh-owner setup,
extended listening and real mobile acceptance remain open, and there is no
availability guarantee.

Install from a Git checkout of this tag using `docs/SELF-HOSTING.md`; the installer
needs Git provenance for its clean-release check. No compiled helper or media
catalog is distributed. Code, documentation and approved artwork use MIT;
dependency licenses and provider/media permissions remain separate.
