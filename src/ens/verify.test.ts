import { test } from "node:test";
import assert from "node:assert/strict";
import { ensNameIsOwnedBy, type Resolve } from "./verify";

const ACME = "0xAcc1000000000000000000000000000000000001";
const OTHER = "0x0BAD000000000000000000000000000000000002";
const book: Record<string, string> = { "acme.factor.eth": ACME };
const resolve: Resolve = async (n) => book[n] ?? null;

test("verified when the name points at the signer", async () => {
  assert.equal(await ensNameIsOwnedBy("acme.factor.eth", ACME, { resolve }), true);
});

test("address case does not matter", async () => {
  assert.equal(await ensNameIsOwnedBy("acme.factor.eth", ACME.toLowerCase(), { resolve }), true);
});

test("unverified when the name points at someone else", async () => {
  assert.equal(await ensNameIsOwnedBy("acme.factor.eth", OTHER, { resolve }), false);
});

test("unverified when the name does not resolve", async () => {
  assert.equal(await ensNameIsOwnedBy("trusted.factor.eth", OTHER, { resolve }), false);
});

test("an empty name is never verified, and never resolved", async () => {
  let called = false;
  const r: Resolve = async () => ((called = true), ACME);
  assert.equal(await ensNameIsOwnedBy("", ACME, { resolve: r }), false);
  assert.equal(called, false);
});

test("a resolver error is unverified, not a failure", async () => {
  const r: Resolve = async () => {
    throw new Error("sepolia down");
  };
  assert.equal(await ensNameIsOwnedBy("acme.factor.eth", ACME, { resolve: r }), false);
});

test("a hung resolver times out as unverified", async () => {
  const r: Resolve = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await ensNameIsOwnedBy("acme.factor.eth", ACME, { resolve: r, timeoutMs: 50 }), false);
  assert.ok(Date.now() - started < 1_000);
});
