import assert from "node:assert/strict";
import { test } from "node:test";
import { joinRelayPath, stripTrailingV1, trimBase } from "../lib/relay-url.js";

test("trimBase strips trailing slashes and whitespace", () => {
  assert.equal(trimBase("https://h.com/"), "https://h.com");
  assert.equal(trimBase(" https://h.com/v1/ "), "https://h.com/v1");
  assert.equal(trimBase(""), "");
});

test("stripTrailingV1 accepts host with or without /v1", () => {
  assert.equal(stripTrailingV1("https://h.com/v1"), "https://h.com");
  assert.equal(stripTrailingV1("https://h.com/V1/"), "https://h.com");
  assert.equal(stripTrailingV1("https://h.com"), "https://h.com");
});

test("joinRelayPath: /v1/... does not double /v1", () => {
  assert.equal(joinRelayPath("https://h.com", "/v1/videos"), "https://h.com/v1/videos");
  assert.equal(joinRelayPath("https://h.com/v1", "/v1/videos"), "https://h.com/v1/videos");
  assert.equal(joinRelayPath("https://h.com/v1/", "/v1/models"), "https://h.com/v1/models");
  assert.equal(joinRelayPath("https://h.com/v1", "/v1/images/generations"), "https://h.com/v1/images/generations");
  assert.equal(joinRelayPath("https://h.com/v1", "/v1/images/edits"), "https://h.com/v1/images/edits");
});

test("joinRelayPath: non-/v1 paths keep a trailing /v1 the user typed", () => {
  assert.equal(joinRelayPath("https://h.com/v1", "/videos/generations"), "https://h.com/v1/videos/generations");
  assert.equal(joinRelayPath("https://h.com", "/videos/generations"), "https://h.com/videos/generations");
  assert.equal(joinRelayPath("https://h.com/v1", "/tasks/submit"), "https://h.com/v1/tasks/submit");
});
