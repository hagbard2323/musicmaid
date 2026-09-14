# Contributing

MusicMaid currently supports one community per self-hosted installation. Changes
that improve recording correctness, recovery, installation and everyday controls
are especially useful. Read [Architecture](docs/ARCHITECTURE.md) and
[Roadmap](docs/ROADMAP.md) before proposing a large new subsystem.

## Development checks

Use Linux, Node.js 22.13 or newer, npm, Python 3, Bash and rsync. Application tests
use temporary SQLite databases, fixtures and mocked services. They need local
socket/subprocess access; terminal tests also need a pseudo-terminal. They do not
need a bot token, provider account, running Lavalink or root access.

```bash
npm ci
npm run check
npm test
npm run build
python3 scripts/test-viewer-config.py
python3 scripts/test-viewer-transaction.py
python3 scripts/test-legacy-rollback.py
python3 scripts/test-github-deploy-wrapper.py
for script in scripts/test-self-host-*.py; do
  python3 "$script"
done
```

The [CI workflow](.github/workflows/ci.yml) checks the application on Node 22 and
24 on Ubuntu 24.04, plus installer fixtures. Use the `test-*.py` programs for
regressions: the similarly named deployment scripts change a real installation.
Do not run builds as root or use real credentials in tests.

The optional Rust helper has a separate locked dependency tree. Changes there
also need a compatible Rust toolchain and updated
[dependency information](apps/spotify-stream/DEPENDENCIES.md). Baseline CI
compiles and tests that locked source with Rust 1.96.1, without provider credentials:

```bash
cargo test --locked --manifest-path apps/spotify-stream/Cargo.toml
```

CI also audits that locked tree against the RustSec database with cargo-audit
0.22.2. Run the same check from the helper directory:

```bash
cd apps/spotify-stream && cargo audit
```

Vulnerabilities fail the job; warnings only print. Every entry in
[`apps/spotify-stream/.cargo/audit.toml`](apps/spotify-stream/.cargo/audit.toml)
needs a reason and the condition under which it is removed. The vendored
connector under `apps/spotify-stream/vendor/hyper-proxy2` keeps its `src/`
identical to the upstream commit recorded in
[third-party notices](THIRD_PARTY_NOTICES.md); only its manifest differs.
Because librespot pins several crates, a new advisory against one of them fails
CI until the lock is updated or an accepted entry with a reason is added; the
advisory database is fetched live, so an unchanged commit can turn red later and
a beta tag then needs a green rerun of that commit's CI first.

The separate [manual stress workflow](.github/workflows/stress.yml) exercises a
bounded single-community fixture workload and writes its measured report. To run
the same workload locally after installing dependencies:

```bash
npm run test:stress -- --seed 20260913 --iterations 1000 --report stress-report.json
```

This workload uses disposable local state and fixtures, not live Discord or music
providers. Live source verification and the optional browser integration harness
remain outside baseline CI.

## Preserve the contracts

- An exact playable link identifies a recording. Automatic retries keep it;
  switching recordings requires the member's choice.
- Commit durable playback transitions before replacing an active attempt. Late
  callbacks and stale menus must not change a newer request.
- Bound external work, timeouts, retries and memory. A viewer failure must not
  stop voice playback.
- Enforce voice access, playlist ownership and edit revisions. Moderator host
  recovery is scoped to the single-community installation.
- Restore matching runtime/database state on update failure while preserving
  current account grants. Do not treat an entire state-directory copy as rollback.
- Count a user request once in charts; looping, retries and seeking are not new requests.

For behavior involving recording identity, persistence, permissions or recovery,
include a focused regression that demonstrates the failure. Small reversible
presentation edits may need only relevant rendering/type checks. Describe what
changed, the concrete trigger, results of relevant checks, and remaining live
validation. Keep dependency updates and unrelated refactors separate.

## Report a bug

Include the installed revision from `/music-admin status`, supported host/version,
enabled source, expected result and steps to reproduce. For a wrong recording,
include public links for the requested and selected recording, artist/title and
durations if known. For interruptions, include elapsed time and an incident ID.
Mention whether another member or mobile client reproduces it.

A moderator can attach the whitelisted JSON from `/music-admin diagnostic`.
It reports health and failure categories without listing members or requested
songs; include public recording links separately when relevant to the bug.

Never attach credentials, browser cookies, callback addresses, signed media URLs,
databases, private backups or unfiltered logs. Report vulnerabilities through
[Security](SECURITY.md), not a public bug report.

## Contribution provenance

Submit only material you have permission to contribute under this repository's
[MIT license](LICENSE). Retain upstream licenses and record the source/license of
third-party code, media and fixtures. Prefer generated test tones or synthetic
responses over commercial recordings and copied service logs. See
[third-party notices](THIRD_PARTY_NOTICES.md).
