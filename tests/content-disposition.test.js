import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentContentDisposition } from "../lib/content-disposition.js";

test("attachmentContentDisposition preserves a simple ASCII filename", () => {
  assert.equal(
    attachmentContentDisposition("product-shot.png"),
    "attachment; filename=\"product-shot.png\"; filename*=UTF-8''product-shot.png",
  );
});

test("attachmentContentDisposition provides an encoded UTF-8 filename", () => {
  const value = attachmentContentDisposition("产品正面图.png");
  assert.match(value, /^attachment; filename="_+\.png";/);
  assert.match(value, /filename\*=UTF-8''%E4%BA%A7%E5%93%81%E6%AD%A3%E9%9D%A2%E5%9B%BE\.png$/);
});

test("attachmentContentDisposition strips paths and cannot inject headers", () => {
  const value = attachmentContentDisposition("../unsafe\r\nname.jpg");
  assert.equal(value.includes("\r"), false);
  assert.equal(value.includes("\n"), false);
  assert.equal(value.includes("../"), false);
  assert.equal(/%0D|%0A/i.test(value), false);
  assert.match(value, /^attachment; filename="unsafe__name\.jpg";/);
});
