# Original Spotify audio helper

This optional Rust process integrates pinned **librespot** code with MusicMaid's
existing audio backend. It is an unofficial client and requires the operator's
eligible paired account. Read [source requirements](../../docs/SOURCES.md) before
enabling it. Spotify catalog metadata and original audio are separate integrations.

The helper receives an access token, device ID, exact track ID, expected duration
and optional starting position through stdin JSON. It checks account access and
recording identity, emits Ogg Vorbis packets on stdout, and reports bounded
structured metadata/fixed errors on stderr. Credentials do not belong in argv
or logs. It does not create a Spotify Connect device, control a personal app's
queue, or create an autoplay context.

The bot prepares a verified recording portion in memory, exposes a short-lived
capability URL on loopback, and removes it when that playback attempt ends.
Payload limits are 64 MiB per preparation and 128 MiB total, with additional
process/copy overhead possible. The reported actual source offset keeps seeking
and resume on the full-song timeline. The helper preserves Vorbis packets;
Lavalink produces Discord's Opus output. Lossless delivery is not claimed.

For an installation, use the [guided self-host setup](../../docs/SELF-HOSTING.md)
and its Sources step. For development, build the locked source from the repository
root with a compatible Rust toolchain:

```bash
cargo build --release --locked --manifest-path apps/spotify-stream/Cargo.toml
```

The supported installer targets AlmaLinux 10 x86_64. No
prebuilt helper binary or account authorization is included in the source tree.

[Cargo.lock](Cargo.lock) records selected dependencies; [DEPENDENCIES.md](DEPENDENCIES.md)
lists their declared licenses and sources. Retain the upstream
[librespot license](LIBRESPOT-LICENSE) and each dependency's applicable notices.
MusicMaid's root MIT license does not relicense those dependencies.

See [Spotify audio](../../docs/SPOTIFY-DIRECT.md) for pairing, validation,
technical limits and recovery. Decoder checks do not prove audible Discord playback.
