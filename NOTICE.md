# Third-party notices and asset provenance

MusicMaid's MIT license covers this project's code, documentation, and selected
artwork. It does not replace dependencies' licenses or grant rights to provider
catalogs, recordings, trademarks, or third-party services.

- JavaScript dependency versions and integrity hashes are pinned in
  [package-lock.json](package-lock.json). Their license files accompany their
  installed packages. This source release does not redistribute `node_modules`.
- The optional Spotify helper uses librespot and other Rust libraries. Keep
  [its upstream license](apps/spotify-stream/LIBRESPOT-LICENSE),
  [dependency inventory](apps/spotify-stream/DEPENDENCIES.md), and
  [Cargo lockfile](apps/spotify-stream/Cargo.lock) with the source. The inventory
  reports declared licenses; it is not a replacement for their terms. The
  vendored hyper-proxy2 connector keeps
  [its MIT license](apps/spotify-stream/vendor/hyper-proxy2/LICENSE-MIT.md).
  Binary redistribution requires the corresponding dependency notices and
  obligations. This beta distributes helper source, not a precompiled helper.
- Lavalink, yt-cipher, yt-dlp and optional system packages are separately
  installed upstream components. Their versions are specified by the installer
  and infrastructure files; their respective licenses continue to apply.
- `assets/profile/musicmaid.png` is the project owner's selected MusicMaid
  artwork, approved for this MIT release. No provider or Discord logo is claimed
  as MusicMaid artwork.
- `assets/ui-preview.svg` is a project-authored schematic using synthetic labels.
  It is an illustration of the controls, not a screenshot of members' activity.
- The regression audio is a generated sine tone. Its generation command,
  purpose and checksum are in [the fixture provenance note](apps/bot/test/fixtures/README.md).

See [source support and limitations](docs/SOURCES.md) before enabling an
integration. Publishing or self-hosting open-source software does not itself
authorize relaying a service's music catalog.
