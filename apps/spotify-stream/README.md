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

## Vendored proxy connector

librespot's HTTP client depends on `hyper-proxy2`. Its only published release,
0.1.0, pins rustls 0.22, whose rustls-webpki 0.102 dependency carries open
RustSec advisories (and rustls-pemfile 2.2, now unmaintained); upstream's update
to hyper-rustls 0.27 is unreleased. `Cargo.toml`
therefore patches `hyper-proxy2` to [vendor/hyper-proxy2](vendor/hyper-proxy2), a
copy of <https://github.com/siketyan/hyper-proxy2> at commit
`2a1a9845f4c9a100c45bf3dc0f1222773d5a33b7` with its
[MIT license](vendor/hyper-proxy2/LICENSE-MIT.md) retained. `src/` is unchanged.
The manifest differs from upstream in three ways: `tokio-rustls` and
`hyper-rustls` are declared with default features off, and `rustls-base` enables
`ring` on both plus `tls12` on `hyper-rustls`, so the helper keeps one rustls
crypto provider; the unused optional dependencies `webpki` and
`rustls-native-certs` are removed; the readme and `[dev-dependencies]` are
dropped. The helper never configures a proxy, so this connector's TLS
configuration is built but not used for traffic.

To check provenance, compare `src/` against a fresh checkout of that commit from
the repository root:

```bash
git clone https://github.com/siketyan/hyper-proxy2 ../hyper-proxy2-upstream
git -C ../hyper-proxy2-upstream checkout 2a1a9845f4c9a100c45bf3dc0f1222773d5a33b7
diff -r ../hyper-proxy2-upstream/src apps/spotify-stream/vendor/hyper-proxy2/src
```

Remove the copy when upstream publishes a release on hyper-rustls 0.27 or the
pinned librespot stops depending on `hyper-proxy2`.
