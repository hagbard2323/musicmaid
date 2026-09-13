MusicMaid's first public source beta targets one self-hosted Discord community
per installation, with a guided AlmaLinux 10 x86_64 setup.

It includes recording-aware playback, persistent FIFO/fair queues, saved
playlists, charts, moderator recovery, diagnostic downloads and optional
synchronized YouTube viewing. Source support and account access have explicit
limitations; see the README and `docs/SOURCES.md`.

Validation: 326 application regressions on Node 22 and 24, 140 installer fixtures,
the locked Rust helper test, and a reproducible 1,000-operation full-queue workload.
Independent fresh-owner setup, extended listening and real mobile acceptance
remain open. This is a beta, with no availability guarantee.

Install from a Git checkout of this tag using `docs/SELF-HOSTING.md`; the installer
needs Git provenance for its clean-release check. GitHub's automatically generated
source archives are useful for source review but lack that checkout metadata.
No compiled helper or media catalog is distributed by this release.

Code, documentation and approved project artwork use MIT. Dependency licenses
and provider/media permissions remain separate. Voice requests and Release Radar
are deferred.
