# Third-party code and provenance

The root [MIT license](LICENSE) covers MusicMaid's original contributions,
including the approved profile artwork. It does not replace the licenses of
dependencies, downloaded tools, container images, or media obtained from providers.
See [NOTICE.md](NOTICE.md) for the included artwork and generated test fixture.

| Component | Recorded inputs and notices |
| --- | --- |
| Node application, Discord libraries and viewer build | `package.json`, `package-lock.json`; preserve each installed package's license/notice files when distributing dependencies or bundles. |
| Optional Rust Spotify helper | `apps/spotify-stream/Cargo.toml`, `Cargo.lock`, [dependency inventory](apps/spotify-stream/DEPENDENCIES.md), and the retained [librespot MIT license](apps/spotify-stream/LIBRESPOT-LICENSE). The vendored hyper-proxy2 connector under `apps/spotify-stream/vendor/hyper-proxy2` (upstream commit `2a1a9845f4c9a100c45bf3dc0f1222773d5a33b7`, sources unchanged, manifest adjusted) keeps its [MIT license](apps/spotify-stream/vendor/hyper-proxy2/LICENSE-MIT.md). |
| Lavalink, plugins and cipher service | Image/plugin references in `infra/lavalink/` and `deploy/`; upstream projects retain their respective licenses. |
| YouTube extractor and supporting tools | Pinned inputs under `deploy/`; downloaded packages retain their own licenses. |

The Rust inventory records declared package licenses; it is not a substitute for
their full license text. A distributor of binaries or combined bundles must retain
the notices and satisfy the applicable licenses for that artifact. This source
repository does not claim that the full dependency graph is MIT-only.

For new dependencies or fixtures, record the upstream URL, exact version or
revision, license and any required attribution. For generated assets, record the
generation method and inputs. Do not add account data, copied commercial music,
book extracts, or third-party artwork without an appropriate distribution basis.

Provider branding and recordings are not project assets. Availability of source
code is separate from permission to access or redistribute a provider's media.
