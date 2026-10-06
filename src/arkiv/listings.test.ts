import { test } from "node:test";
import assert from "node:assert/strict";
import { listingIsSold } from "./listings";

const ACME = "0xAcc1000000000000000000000000000000000001";
const FIN = "0xF100000000000000000000000000000000000001";
const FIN2 = "0xF200000000000000000000000000000000000002";

test("unsold while the seller still holds the claim", () => {
  assert.equal(listingIsSold({ holder: ACME, issuer: ACME }, { holder: ACME, settled: false }), false);
});

test("address case does not matter", () => {
  assert.equal(
    listingIsSold({ holder: ACME.toLowerCase(), issuer: ACME }, { holder: ACME.toUpperCase().replace("0X", "0x"), settled: false }),
    false,
  );
});

test("sold once someone else holds it", () => {
  assert.equal(listingIsSold({ holder: ACME, issuer: ACME }, { holder: FIN, settled: false }), true);
});

test("sold once settled and burned", () => {
  assert.equal(listingIsSold({ holder: ACME, issuer: ACME }, { holder: null, settled: false }), true);
  assert.equal(listingIsSold({ holder: ACME, issuer: ACME }, { holder: ACME, settled: true }), true);
});

test("a resale listing speaks for its own seller, not the issuer", () => {
  // A financier bought from ACME and relisted: still unsold while FIN holds it.
  assert.equal(listingIsSold({ holder: FIN, issuer: ACME }, { holder: FIN, settled: false }), false);
  assert.equal(listingIsSold({ holder: FIN, issuer: ACME }, { holder: FIN2, settled: false }), true);
});

test("listings from before `holder` existed fall back to the issuer", () => {
  assert.equal(listingIsSold({ issuer: ACME }, { holder: ACME, settled: false }), false);
  assert.equal(listingIsSold({ issuer: ACME }, { holder: FIN, settled: false }), true);
});
