import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addSessionFile,
  emptyLedger,
  parseLedgerRaw,
  readSessionDocument,
  readSessionLedger,
  removeSessionFile,
} from "../lib/session-ledger.js";

test("parseLedgerRaw: array becomes files-only document", () => {
  const doc = parseLedgerRaw(["newapi_image/a.png", "newapi_output/b.mp4", ""]);
  assert.deepEqual(doc.files, ["newapi_image/a.png", "newapi_output/b.mp4"]);
  assert.equal(doc.roundId, "");
  assert.equal(doc.turntableConfirmed, false);
  assert.deepEqual(doc.shots, {});
});

test("parseLedgerRaw: object keeps shots and files", () => {
  const doc = parseLedgerRaw({
    files: ["newapi_image/a.png"],
    roundId: "mabc",
    turntableConfirmed: true,
    shots: { _turntable: { role: "turntable", shot_id: "_turntable", path: "newapi_image/a.png", refs: [], prompt: "", size: "", updatedAt: 1 } },
  });
  assert.equal(doc.roundId, "mabc");
  assert.equal(doc.turntableConfirmed, true);
  assert.equal(doc.shots._turntable.role, "turntable");
});

test("parseLedgerRaw: object without files uses empty files", () => {
  const doc = parseLedgerRaw({ roundId: "m1" });
  assert.deepEqual(doc.files, []);
  assert.equal(doc.roundId, "m1");
});

test("emptyLedger shape", () => {
  assert.deepEqual(emptyLedger(), {
    files: [],
    roundId: "",
    turntableConfirmed: false,
    shots: {},
  });
});

test("addSessionFile upgrades array ledger to object and preserves later shots via read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nva-ledger-"));
  try {
    await writeFile(join(dir, ".dsh-newapi-session.json"), JSON.stringify(["newapi_image/old.png"]), "utf8");
    await addSessionFile(dir, join(dir, "newapi_image", "new.png"));
    const raw = JSON.parse(await readFile(join(dir, ".dsh-newapi-session.json"), "utf8"));
    assert.equal(Array.isArray(raw), false);
    assert.ok(raw.files.includes("newapi_image/old.png"));
    assert.ok(raw.files.includes("newapi_image/new.png"));
    assert.equal(raw.roundId, "");
    assert.equal(raw.turntableConfirmed, false);
    assert.deepEqual(raw.shots, {});
    const set = await readSessionLedger(dir);
    assert.equal(set.has("newapi_image/old.png"), true);
    assert.equal(set.has("newapi_image/new.png"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addSessionFile on object ledger does not drop shots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nva-ledger-"));
  try {
    await writeFile(
      join(dir, ".dsh-newapi-session.json"),
      JSON.stringify({
        files: ["newapi_image/a.png"],
        roundId: "mkeep",
        turntableConfirmed: true,
        shots: { _turntable: { role: "turntable", shot_id: "_turntable", path: "newapi_image/a.png", refs: ["p.png"], prompt: "t", size: "1024x1024", updatedAt: 9 } },
      }),
      "utf8",
    );
    await addSessionFile(dir, join(dir, "newapi_image", "b.png"));
    const doc = await readSessionDocument(dir);
    assert.equal(doc.roundId, "mkeep");
    assert.equal(doc.turntableConfirmed, true);
    assert.equal(doc.shots._turntable.prompt, "t");
    assert.ok(doc.files.includes("newapi_image/b.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeSessionFile keeps shots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nva-ledger-"));
  try {
    await writeFile(
      join(dir, ".dsh-newapi-session.json"),
      JSON.stringify({
        files: ["newapi_image/a.png", "newapi_image/b.png"],
        roundId: "mkeep",
        turntableConfirmed: false,
        shots: { Hero_01: { role: "shot", shot_id: "Hero_01", path: "newapi_image/b.png", refs: [], prompt: "", size: "", updatedAt: 1 } },
      }),
      "utf8",
    );
    await removeSessionFile(dir, "newapi_image/a.png");
    const doc = await readSessionDocument(dir);
    assert.deepEqual(doc.files, ["newapi_image/b.png"]);
    assert.equal(doc.shots.Hero_01.shot_id, "Hero_01");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
