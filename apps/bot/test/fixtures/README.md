# Audio fixture provenance

`stereo-vorbis.ogg` is a synthetic 440 Hz sine wave generated for MusicMaid on
2026-09-13. It contains no song, voice, downloaded recording, or provider audio.
It is distributed under the repository's MIT license.

Generate an equivalent fixture with FFmpeg and libvorbis:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=2' -ac 2 -c:a libvorbis -b:a 320k -map_metadata -1 -y apps/bot/test/fixtures/stereo-vorbis.ogg
```

The checked-in file is two seconds, stereo, 44.1 kHz, with a nominal Vorbis
bitrate of 320 kbit/s. Tests check format, stream ranges, cancellation, and
recording identity plumbing; the tone does not establish perceptual music
quality. Encoder versions and Ogg serial numbers can change the file bytes.

Checked-in SHA-256:
`3f93f7e4ea65f08117d042ccd8937c237a81c714fe36d6785aca4f4635c85a07`.

See [FFmpeg's sine source documentation](https://ffmpeg.org/ffmpeg-filters.html#sine).
