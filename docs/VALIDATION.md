# Validation

Evidence summary prepared **2026-09-13** for the self-hosted beta. Results below
come from the implementation before public packaging. They establish specific
tested behavior, not a public deployment, universal provider access or an uptime
promise. The exact public export must pass its own CI/build checks after its clean
commit is created; consult that revision's workflow result.

## Automated application and installer evidence

The candidate passes **326 application regressions on both Node 22.23.2 and
24.18.0**, plus **140 Python installer regressions**, including the 18 new cleanup
fixtures.
TypeScript checks pass. The public-export policy separately passes **22 boundary
tests**; that private-to-public packaging tool is not shipped as a runtime feature.
The exact clean public checkout is checked separately before publication.
Earlier application CI also covered Node 22 and 24; the new public repository
will have its own workflow results.

Coverage includes recording identity and source selection, stale interactions,
durable playback transitions, fair queueing, playlist ownership/imports,
same-recording recovery, extractor cancellation, viewer admission, process
watchdog behavior and release-input checks. Installer fixtures cover terminal
secrecy, malicious service-owned settings, altered build inputs, host conflicts,
maintenance locks, inactive services and rollback preserving refreshed grants.

Tests use fixtures, temporary databases, local sockets, subprocesses and mocked
service actions. They do not log a bot into Discord or authorize a provider account.
Baseline CI also compiles and tests the optional Spotify helper's locked Rust
source with Rust 1.96.1. Its single account-free Rust regression passed locally
during public preparation; the exact public revision's hosted CI result must be
observed separately.

A separate manually dispatched fixture-stress workflow runs a seeded, bounded
single-community workload and reports measurements. It is not a live Discord or
provider load test. Live source verification and the isolated browser harness
remain separate from baseline CI. Commands are in [Contributing](../CONTRIBUTING.md).

## Reliability work in this candidate

Added fixtures exercise three seeded coordinator/SQLite traces (120 steps each),
scope checks before decoding foreign snapshots, old-schema migration, failed
event checkpoints, a competing database writer, queue selection and stale edits,
diagnostic privacy, and a timed-out cleanup writer. The cleanup worker test
confirms transaction rollback and lock release before the bot may restart.
Existing update/rollback fixtures remain part of CI.

Provider/viewer fixtures cover early EOF, refused grants and rate limits,
bounded worker/stream admission, cancellation, forced child termination, and
capacity recovery. Local HTTP servers exercise real socket lifetimes where
relevant; Discord and provider calls stay mocked.

## Measured full-queue workload

The [raw Btrfs report](validation/stress-2026-09-13-btrfs.json) records seed
**20260913**, **1,000 operations**, 500 upcoming tracks, a 500-track saved playlist,
rejection of a 501-track playlist, 25 concurrent initial queue batches, and 400
simulated controls. It passed with no invariant failures or leftover backend
attempts/guild actions, and no network requests.

Measured on Fedora 44, Node 24.18.0, an Intel i5-10400F with 12 logical CPUs,
15.5 GiB RAM, and a Btrfs-backed temporary SQLite database:

| Observation | Result |
| --- | --- |
| Entire workload | 21.47 seconds |
| Local defer callback, p95 / maximum | 2.04 / 3.27 ms |
| Completed fixture handler, p95 / maximum | 25.73 / 31.15 ms |
| Event-loop lag, p95 / maximum | 49.09 / 305.40 ms |
| Peak process RSS | 241.7 MiB |
| Local defer budget | All 400 below 3,000 ms |

These defer timings measure entry into `handle()` through a stub `deferReply()`.
They exclude Gateway scheduling, Discord round trips, source extraction,
decoding and audible delivery. RSS was observed without forced garbage
collection. A passing short workload does not establish a leak-free long-running
process, a hardware minimum, or an availability guarantee. The same seed also
passed on tmpfs; the published report uses the local disk filesystem.

Reproduce on an existing writable filesystem:

```bash
npm run test:stress -- --seed 20260913 --iterations 1000 --storage-dir . --report stress-report.json
```

The runner creates and removes only its own fresh temporary subdirectory. The
manual **Fixture stress** GitHub workflow runs the bounded default profile. Do
not run stress work against a community call or real provider APIs.

## Clean AlmaLinux lifecycle exercise

A disposable VM used the publisher-checksummed **AlmaLinux 10.2 Generic Cloud
x86_64** image, QEMU software emulation, two virtual CPUs, 4 GiB RAM and a 24 GiB
sparse disk. This is a tested fixture configuration, not a measured minimum
resource recommendation.

The real installer bootstrapped Node 22.23.2, Podman 5.8.2 and required packages.
It installed the actual pinned Lavalink 4.2.2/cipher images. For bot lifecycle
checks, it used an explicitly synthetic process with SQLite and the compiled
watchdog, without Discord login or music-account credentials.

Observed results:

- Fresh setup created service accounts, private configuration, root-owned tool
  locations, ownership markers and systemd/Quadlet services.
- Authenticated audio readiness recovered after slow emulated startup without a
  manual restart; host-specific path/permission issues found by this exercise
  were fixed and added to fixtures.
- Real backup/update/rollback restored the expected fixture revision and SQLite
  payload while retaining a newer synthetic account grant.
- A deliberately non-starting update automatically restored the prior working
  fixture/runtime/database. Backing up an inactive bot left it inactive.
- Host reboot started the expected services and recovered readiness. Separate
  isolated frozen-loop fixtures demonstrated watchdog termination, forced kill
  escalation and bounded restart limits.
- Unprivileged YouTube tool preparation downloaded pinned inputs and generated
  its checked artifact manifest, without using an account/session.

This establishes installer and recovery behavior on that image. It does not
establish fresh-account consent, full music playback or Activity availability.

## Earlier live-source and viewer evidence

The originating community confirmed audible playback and optional viewer launch
on an earlier installed revision. Isolated source/decoder checks exercised
original Spotify audio and positioned playback; a browser fixture exercised
video pause, seek, transition and waiting without affecting voice state. These
results depend on those accounts, host access and software versions. They do not
replace acceptance of a new installation or the public beta's current controls.

## Still required before a stable release

- Install from the exact public candidate with an independently owned Discord
  application and provider accounts, without undocumented maintainer intervention.
- Complete full playback and pairing per enabled provider, plus optional HTTPS
  Activity setup as an ordinary member.
- Listen for **more than two hours**, including niche/ambiguous recordings,
  recovery and transitions; record wrong versions separately from interruptions.
- Test another member and an actual Discord mobile client: forms, stale controls,
  old-card navigation, FIFO/Fair queues and playlist sharing.
- Repeat update/restore on the candidate's supported configuration and record the
  revision and any loss/restoration of queue/library state.

Use the [member acceptance checklist](COMMUNITY-BETA.md#beta-acceptance) and
[self-hosting guide](SELF-HOSTING.md). A green health check is not a listening result.
