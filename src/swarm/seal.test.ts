import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "viem";
import {
  commitToReference,
  openSealed,
  pubkeyFromEnsRecord,
  sealTo,
  verifyCommitment,
} from "./seal";

const keypair = () => {
  const priv = secp256k1.utils.randomPrivateKey();
  return {
    priv: bytesToHex(priv),
    pub: bytesToHex(secp256k1.getPublicKey(priv, false)),
    pubCompressed: bytesToHex(secp256k1.getPublicKey(priv, true)),
  };
};

// An encrypted Swarm reference: 128 hex chars, decryption key included.
const REF = "ab".repeat(64);

test("round trip to an uncompressed key", () => {
  const r = keypair();
  assert.equal(openSealed(r.priv, sealTo(r.pub, REF)), REF);
});

test("round trip to a compressed key", () => {
  const r = keypair();
  assert.equal(openSealed(r.priv, sealTo(r.pubCompressed, REF)), REF);
});

test("each seal is fresh: same input, different ciphertext", () => {
  const r = keypair();
  assert.notEqual(sealTo(r.pub, REF), sealTo(r.pub, REF));
});

test("the wrong recipient cannot open it", () => {
  const r = keypair();
  const other = keypair();
  assert.throws(() => openSealed(other.priv, sealTo(r.pub, REF)));
});

test("any flipped ciphertext byte is rejected", () => {
  const r = keypair();
  const sealed = sealTo(r.pub, REF);
  const tail = sealed.length - 2; // last byte of the auth tag
  const flipped = (sealed.slice(0, tail) +
    (parseInt(sealed.slice(tail), 16) ^ 1).toString(16).padStart(2, "0")) as `0x${string}`;
  assert.throws(() => openSealed(r.priv, flipped));
});

test("a swapped ephemeral key is rejected", () => {
  const r = keypair();
  const sealed = sealTo(r.pub, REF);
  const eph = keypair().pub.slice(2); // 65 bytes, hex
  const forged = `0x${eph}${sealed.slice(2 + 130)}` as `0x${string}`;
  assert.throws(() => openSealed(r.priv, forged));
});

test("truncated envelopes are rejected", () => {
  const r = keypair();
  assert.throws(() => openSealed(r.priv, "0x1234"), /too short/);
});

test("bad recipient key lengths are rejected", () => {
  assert.throws(() => sealTo("0x1234", REF), /33 or 65 bytes/);
});

test("pubkeyFromEnsRecord rebuilds the key the ENS record stores", () => {
  const r = keypair();
  const x = `0x${r.pub.slice(4, 68)}` as `0x${string}`;
  const y = `0x${r.pub.slice(68)}` as `0x${string}`;
  const rebuilt = pubkeyFromEnsRecord(x, y);
  assert.equal(rebuilt, r.pub);
  assert.equal(openSealed(r.priv, sealTo(rebuilt, REF)), REF);
});

test("the on-chain commitment binds the exact reference", () => {
  const c = commitToReference(REF);
  assert.ok(verifyCommitment(REF, c));
  assert.ok(verifyCommitment(REF, c.toUpperCase().replace("0X", "0x") as `0x${string}`));
  assert.ok(!verifyCommitment("cd".repeat(64), c));
});
