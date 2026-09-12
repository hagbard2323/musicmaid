# Project map

MusicMaid is a self-hosted music bot for one Discord community. Its design keeps
member interaction, durable playback state, audio transport and optional video
in separate layers.

- [Architecture](docs/ARCHITECTURE.md): module boundaries, playback flow and failure handling.
- [Self-hosting](docs/SELF-HOSTING.md): supported installation and account setup.
- [Member controls](docs/COMMUNITY-BETA.md) and [playlists](docs/PLAYLISTS.md): current behavior.
- [Operations](docs/OPERATIONS.md): diagnostics, updates and recovery.
- [Validation](docs/VALIDATION.md): completed evidence and remaining acceptance.
- [Roadmap](docs/ROADMAP.md): release priorities and deferred work.
- [Sources](docs/SOURCES.md): implemented integrations, access requirements and limitations.

Use the revision shown in `/music-admin status` when reporting runtime behavior.
Source documentation describes the checkout; it does not establish that an
operator has deployed that revision.
