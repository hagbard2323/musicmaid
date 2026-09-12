import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceBlockReason, type VoiceReadiness } from "../src/audio/voice-readiness.js";
import { failureMessage } from "../src/audio/diagnostics.js";

const ready: VoiceReadiness = { channelId: "voice", channelName: "[movies]", regularVoice: true, view: true, connect: true, speak: true, moveMembers: false, otherMembers: 2, userLimit: 0, muted: false, timedOut: false, alreadyConnected: false };
test("movies permission regression: Connect and Speak alone do not permit joining a hidden channel", () => {
  const reason = voiceBlockReason({ ...ready, view: false });
  assert.match(reason!, /View Channel/); assert.match(reason!, /movies/);
  assert.equal(failureMessage(reason!), reason);
});
test("voice capacity blocks new joins but allows Move Members or an existing connection", () => {
  assert.match(voiceBlockReason({ ...ready, userLimit: 2 })!, /full.*2\/2/);
  assert.equal(voiceBlockReason({ ...ready, userLimit: 2, moveMembers: true }), undefined);
  assert.equal(voiceBlockReason({ ...ready, userLimit: 2, alreadyConnected: true }), undefined);
  assert.equal(voiceBlockReason(ready), undefined);
});
test("voice permission failures are not described as unavailable songs", () => {
  assert.match(failureMessage("Voice: channel is unavailable"), /^Voice:/);
  assert.match(failureMessage("The voice connection is not established in 15 seconds"), /Discord.*voice join/);
});
