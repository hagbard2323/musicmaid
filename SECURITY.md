# Security

Security fixes target the latest beta revision. There is no long-term-support
branch or guaranteed response time. This project is intended for one trusted
community per installation, with an operator who controls its host and accounts.
Shared multi-community hosting is outside the supported boundary.

## Report privately

Use **Security → Report a vulnerability** on
[hagbard2323/musicmaid](https://github.com/hagbard2323/musicmaid/security).
If private reporting is unavailable, open an issue asking for a private contact
without including exploit details or sensitive data. Do not post working account
credentials or an exploit against a live community.

Include the affected revision, component, prerequisites, impact, and a minimal
reproduction using synthetic data or your own isolated installation. Identify
whether the issue crosses a member/moderator, service-account, viewer or host
boundary. Never test against another operator's bot without authorization.

## Dependency advisories

Dependabot alerts are enabled for this repository. CI audits the optional Rust
helper's locked dependencies against the RustSec database; a vulnerability fails
the job. Advisories accepted rather than fixed are recorded with their reasons in
[the audit configuration](apps/spotify-stream/.cargo/audit.toml). If a dependency
issue is exploitable in MusicMaid as deployed, report it the same private way.

## Operator responsibilities

Keep `.env`, `.setup/`, provider sessions/grants, databases and backups private.
Revoke exposed credentials with the provider before attempting configuration
repair. Use setup's hidden prompts and run the setup entrypoint as a normal
account; it handles the narrow privileged operations separately.

Keep internal audio and IPC endpoints private. Only the optional viewer needs
public HTTPS. The viewer runs separately and does not receive the bot token or
provider account grants. Updates are reviewed operator actions, not automatic
pull-and-execute jobs.

The bot stores member/server identifiers, song requests, playlists and listening
statistics on the operator's host. The recent-history display is bounded, but
the statistics ledger persists beyond it. Operators can preview and apply narrowly
scoped statistics cleanup; this is not automatic retention or comprehensive
per-member erasure. See [Data policy](docs/DATA-POLICY.md). Explain data use to
members and control backups and log access accordingly.
