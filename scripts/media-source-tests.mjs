import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Use the project's existing TS compiler so these checks also work on Node 20.
const source = readFileSync(new URL("../src/media_sync.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { createMediaPoll, canTransport, clampSeek } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("source mutation discards an old read and refreshes after selection completes", async () => {
  let finishRead;
  const accepted = [];
  let reads = 0;
  let discarded = 0;
  const poll = createMediaPoll({
    read: () => ++reads === 1 ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve({ revision: "browser-new" }),
    accept: value => accepted.push(value), error: error => { throw error; }, discard: () => discarded++,
  });
  const oldRead = poll.refresh();
  const finishSelection = poll.beginMutation();
  finishRead({ revision: "desktop-old" });
  await oldRead;
  assert.deepEqual(accepted, []);
  assert.equal(discarded, 1);
  await finishSelection();
  assert.deepEqual(accepted, [{ revision: "browser-new" }]);
  poll.stop();
});

test("missing/unknown browser playback state never enables transport or seek", () => {
  assert.equal(canTransport(null, "play_pause"), false);
  const media = { playbackState: "unknown", canPlay: true, canPause: true, canNext: false, canPrevious: false };
  assert.equal(canTransport(media, "play_pause"), false);
  assert.equal(canTransport(media, "next_track"), false);
  assert.equal(clampSeek({ canSeek: false, trackKey: "old", seekMinMs: 0, seekMaxMs: 100 }, 50), null);
});
