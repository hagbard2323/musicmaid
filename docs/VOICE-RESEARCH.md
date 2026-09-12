# Voice commands: postponed research

Updated 13 September 2026. **Voice commands are not part of this beta.** MusicMaid
does not implement microphone capture, speech recognition or a wake phrase. There
is no voice-command service to enable and no transcription account to configure.
Release Radar is also postponed; see the [roadmap](ROADMAP.md).

The explored goal is to avoid typing a song request. A button that briefly listens
for a request could meet that goal without an always-listening assistant. The
decision to postpone protects the beta's priority: reliable music playback.

## Feasibility and isolation

Discord voice reception is technically possible with DAVE encryption. The released
`@discordjs/voice` 0.19.2 receiver includes DAVE decryption, but the library explicitly
warns that Discord does not document audio reception and stable support is not
guaranteed. A working receiver is therefore evidence for a prototype, not an uptime
promise. [Discord voice protocol](https://docs.discord.com/developers/topics/voice-connections),
[released receiver](https://github.com/discordjs/discord.js/blob/@discordjs%2Fvoice@0.19.2/packages/voice/src/receive/VoiceReceiver.ts#L157),
[library support warning](https://discord.js.org/docs/packages/voice/0.19.2)

MusicMaid currently lets Lavalink own the voice connection and joins deafened.
Opening an independent receiver connection under the same bot identity could
conflict with that transport. Lavalink's integration guidance explicitly warns
against creating a second voice connection through the Discord library.
[Lavalink integration guidance](https://lavalink.dev/api/#common-pitfalls)

The candidate for a future experiment is an isolated companion bot with its own
identity and a bounded request interface to MusicMaid. Its failure must not stop
music, alter the queue, or restart the playback service. A browser microphone
interaction is another option to evaluate. Neither is implemented or selected
as a supported installation path.

| Interaction | Benefit | Extra work and uncertainty |
| --- | --- | --- |
| Button, then speak | Explicit start; brief capture for the member who clicked | Discord receive compatibility, speech boundaries, ambiguous artist/title recognition and a visible cancel/retry path |
| Wake phrase, then request | No initial click | Continuous audio analysis, activation errors, overlapping speech, background music and broader consent requirements |
| Conversational assistant | Follow-up corrections and context | More state, latency, cost, permission checks and ways to misunderstand a request |

The receiver API can subscribe to a particular user's audio. A future button flow
should use that boundary rather than transcribing the entire channel. Spoken
provider names would still have to pass the ordinary source-selection and recording
checks. [Receiver API](https://discord.js.org/docs/packages/voice/0.19.2/VoiceReceiver:Class)

## Conditions before any prototype becomes a feature

- Capture is opt-in, clearly indicated and time-limited, with cancellation and a
  community-level off switch. Joining a channel is not consent to transcribe it.
- Only the requesting member's bounded audio is processed. Raw audio is discarded
  after the request; transcripts do not silently become permanent history.
- A cloud transcription option must disclose where audio goes and its retention
  terms. Local transcription would still need measured CPU/memory isolation.
- A transcript is untrusted input. It can propose a normal music request, not run
  arbitrary commands, grant permissions, or perform moderator operations.
- Uncertain titles or providers require correction. Recognition failure must leave
  the current track and queue intact.
- Tests must cover encrypted-channel joins/leaves, concurrent speakers, accents,
  multilingual titles, cancellation, provider timeout and long listening sessions.

There are **no measured results** yet for recognition accuracy, end-to-end latency,
concurrent requests, host capacity or music continuity during capture. Provider
permission also remains separate: Spotify's policy includes restrictions on voice
control, so that source cannot be assumed eligible for a future voice integration.
[Spotify Developer Policy](https://developer.spotify.com/policy),
[source limitations](SOURCES.md)

## Planning estimates retained from 12 September 2026

These are rough engineering envelopes for alternative levels of scope, not quotes,
measured effort, a delivery schedule or additive milestones. Dependencies and
acceptance failures could expand them. The development-token column records a
speculative amount of AI-assisted development work; it is not observed usage,
runtime transcription tokens or a promised bill.

| Scope considered | Engineering effort estimate | Development-token estimate |
| --- | --- | --- |
| Voice receive feasibility spike | 2–4 days | 0.3–1 million |
| Button-activated beta | 6–12 days | 1–4 million |
| Polished, reliable voice requests | 15–30 days | 3–10 million |
| Wake-phrase experience | 30–60 days | 6–20 million |
| Conversational assistant | 50–100+ days | 12–40 million |

For a separate **transcription-only** cost illustration, assume each request sends
eight seconds of audio once. The published rates were rechecked on 13 September
2026; the 4o rates are estimated per-minute equivalents, while GPT-Transcribe lists
duration pricing. [OpenAI transcription pricing](https://developers.openai.com/api/docs/pricing#transcription-models),
[GPT-Transcribe pricing](https://developers.openai.com/api/docs/models/gpt-transcribe)

| Model | USD per audio minute | 1,000 requests | 10,000 requests |
| --- | --- | --- | --- |
| `gpt-4o-mini-transcribe` | $0.003 | about $0.40 | about $4.00 |
| `gpt-transcribe` | $0.0045 | about $0.60 | about $6.00 |
| `gpt-4o-transcribe` | $0.006 | about $0.80 | about $8.00 |

Calculation: `requests × 8 / 60 × price per minute`. These examples exclude
retries, silence, always-on listening, text interpretation, generated speech,
hosting, taxes and maintenance. They are not a complete feature cost or a choice
of provider. No transcription dependency or API integration is included.
