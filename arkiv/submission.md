# Factor — Arkiv submission evidence index

An optional evidence index, not an extra artifact: it collects the exact
locations a reviewer needs so each claim can be traced to code and to a
transaction.

- Repository: https://github.com/feedddosever/sbornayasolyanka (public)
- Deployment: https://sbornayasolyanka.vercel.app
- Feedback report: [`arkiv/friction.md`](./friction.md) — 8 items with reproduction steps
- Mission evidence, long form: [`arkiv/missions.md`](./missions.md)
- Schema rationale: [`arkiv/schema.md`](./schema.md)
- Missions claimed: **Mission 02** and **Mission 03**. Mission 01 is not claimed.

## Product

Factor is invoice financing. A small business sells a receivable at a discount
instead of waiting sixty days. Doing that today means handing the full invoice —
counterparty names, line items, prices — to every financier who might bid.

Factor splits it: the claim is an eligibility-gated ERC-721 on Avalanche Fuji,
the document is encrypted on Swarm with only the buyer receiving the key, and the
bid book plus the discovery index are Arkiv entities.

## Why Arkiv rather than a Web2 database

The market needs a **mutable, queryable set where every row carries its own
lifetime**, and that specific shape is what Arkiv provides.

- Postgres gives the set and the queries but not verifiability, and expiry
  becomes a cron job. Omit the `WHERE created_at` clause in one client and you
  have served a stale quote; here the row is not there to serve.
- A Swarm feed gives a verifiable, mutable *pointer*. No number of feeds answers
  "unsold logistics invoices over 5,000 maturing inside my horizon rated 3 or
  better", which is one predicate here.
- An on-chain array gives verifiability and charges for every byte.

`$expiresAt` is a system attribute that can be **filtered on**, so "live bids" is
a predicate rather than a convention every reader must uphold.

The user-visible capability: an issuer always chooses between quotes that are
live by construction, and a financier never has to withdraw a stale price.

**The query the product depends on** — five clauses, four types, one system
attribute:

```
project = str('factor-invoice-market-ethrome-2026')
  AND kind = str('bid')
  AND invoice_id = u256(4242)
  AND discount_bps <= i32(10000)
  AND $expiresAt > u64(<current block>)
```

Source: `src/arkiv/bids.ts`, `liveBidsFor`.

## Intended users and first 100

Issuers: small businesses with receivables in logistics, manufacturing and
services, where sixty-day terms are standard and payroll is not.
Financiers: small funds wanting short-duration secured paper who cannot see this
deal flow today.

Distribution: not by recruiting a hundred issuers, but through **bookkeepers and
small factoring brokers** who already hold invoice flow — one practice brings
dozens of issuer clients. The delegated-accountant role in the ENSv2 subregistry
exists for exactly that: the practice acts for the client without owning the
client's name. A hundred issuers is three or four practices.

---

# Mission 02 — Built to expire

Lifetime in blocks: 20
Requested lifetime: 40 seconds
Requested versus applied: requested 40s; applied expiration height from the
receipt `createdAt 356095` → `expiresAt 356115`, a difference of **20 blocks**.
Block production is not a clock, so the applied height is the authority and the
UI renders countdowns from it, never from the requested duration.

Creation transaction: `0xa9235a9715f433f41bef77613b869e453512d89408236827e91ba9c149b07651`
Entity key: `0x1f89e5fbeeb0569b35f4e625f3f50191b21fb2cdc66956d0b8ae9e8879e84412`

The query: identical at every execution; only `atBlock` moves.

```
project = str('factor-invoice-market-ethrome-2026') AND kind = str('bid')
  AND invoice_id = u256(8889) AND discount_bps <= i32(10000)
  AND $expiresAt > u64(<block>)
```

Before: block **356097** — query returns **1 bid**.
After: block **356116** — the same query returns **0 bids**.
Historic replay: the same query pinned to `atBlock` 356097 still returns
**1 bid**, which shows the entity genuinely occupied the index and left unaided.
Without that third read, "the bid is gone" is equally consistent with "it was
never indexed".

No delete evidence: there is no `deleteEntity` call anywhere in this
repository and no cleanup job. `grep -rn deleteEntity src/ scripts/` returns
nothing. Bids have no cancel endpoint by design — expiry is the cancel.

Visible application change: on the deployment, the bid row carries a
countdown derived from the entity's own `expiresAt` height; when the boundary
passes the row leaves the book, the best price the issuer sees changes, and the
Accept button loses its target. Verified in a browser: a 60-second bid appeared
4 seconds after the click, counted down 62 → 57 → 50 → 45 → 38 → 33 → 26 → 21 →
14 → 8, and was gone at 64 seconds. The countdown alone is not the evidence; the
query above is.

Reproduce: `python3 scripts/evidence-rpc.py` (talks to the JSON-RPC directly,
no SDK), or `npx tsx scripts/evidence.ts` (through the app's own query layer).

---

# Mission 03 — Live wire

WebSocket client: `src/arkiv/client.ts`, `arkivSocket()` — built with
`webSocket(ARKIV_WS)` transport, not `http()`.
Live watcher: `src/arkiv/watch.ts`, `watchWithResync()` calling
`watchEntityEvents`.
No start block: `fromBlock` is **not passed** to the live watcher anywhere in
this repository. Passing one selects polling even on a websocket transport, which
is the trap this mission is about, so it is deliberately absent. Verify with
`grep -rn fromBlock src/` — the only occurrences are comments explaining why it
is omitted.
No refresh loop: no `setInterval` in the application touches the network. The
single interval that exists advances a local clock for countdown interpolation
and issues no requests.

Filters: the subscription is narrowed to the entity events this UI acts on —
`created`, `deleted`, `expiryExtended` — in `src/arkiv/watch.ts` (`RELEVANT`
set). A patch to an unrelated entity is not a reason to re-read the bid book.
The event carries no attributes, so relevance is then confirmed by a bounded
event-triggered read of the authoritative query, never by trusting event
metadata.

Event-triggered hydration: the stream carries "something changed"; the query
carries "here is the truth". `src/app/page.tsx` calls the bid query on an event
through a ref, so the socket opens once for the page lifetime. This is an
event-triggered read, not a periodic refresh.

UI evidence: two clients demonstrated. A write was issued from **outside the
browser**, and the page updated with **no refresh and no repeating query timer**.
The row appeared **4 seconds** after the write was submitted — and before the
write's own HTTP response had returned, which a polling interval cannot do.

Relevant and irrelevant events: during a three-second window the filtered
subscription received **3 events belonging to other projects** on the shared
testnet. They did not update this view, because the entity key did not match the
bid under observation. Filtering by contract and topic narrows the stream;
project and entity identity are then checked before any UI change.

Endpoint: `wss://rpc.tiramisu.db-chain.testnet.arkiv.network` — no access key
in this URL.
Entity key: `0x1cb82889c9374e8d01caa3947735d14359e932a6e59b6390edd8899443b68bb9`
Creation transaction: `0x8ff0e3080024799eff152ce4890c535433dd4257cac9227beaf0f3880847411b`
Observed: socket open 360 ms; event delivered at block 356475.

Cleanup: the watcher is stopped on unmount — `handle.stop()` in the effect's
teardown.
**Reconnect, stated honestly:** a dropped connection resyncs by re-running the
query rather than replaying events, because replay would need `fromBlock`. Full
reconnect recovery, exactly-once delivery and backfill deduplication are **not
implemented and not tested**. This is disclosed rather than claimed.

Reproduce: `node scripts/evidence-ws.mjs`. Diagnostic that distinguishes a
silent subscription from a silent socket: `node scripts/ws-probe.mjs`.

---

# Why only two missions

Mission 01 Decommission is deliberately left out. Factor is new this weekend. There is no subgraph, Ponder service or Postgres
pipeline that it stopped calling, so nothing here was decommissioned. The
adjacent honest claim — that the bid book is exactly the workload that would
conventionally be a subgraph plus a Postgres table, and that this read path calls
neither — is "would not have needed an indexer", not "turned one off". Inventing
a dummy indexer in order to switch it off would not be evidence.

Per the published note, completing three missions gives three prize lines but
only one payout, so a stretched third claim would add nothing except doubt
about the two that are real.

---

# Creator wallet and entity mapping

Creator wallet, public: `0x2A058020fa86281b6695Fad49c302182ec8aeA34`
(Tiramisu, chainId 7738577)

| Entity key | Creation transaction | Mission |
|---|---|---|
| `0x1f89e5fb…79e84412` | `0xa9235a97…49b07651` | 02 |
| `0x1cb82889…43b68bb9` | `0x8ff0e308…0847411b` | 03 |
| `0x3a36af66…` | `0x7732f858…` | 02, through the product API |

Creator versus owner: identical for every entity above; no ownership
transfer was performed.

Entities are written server-side because signing keys must not reach the browser.
Factor is therefore a **custodial index writer**, so `$owner` is always Factor's
key and "whose bid is this" is the `financier` **attribute**. The non-custodial
shape is kept in `bidsSignedBy` in `src/arkiv/bids.ts` to show what would change.
Stated plainly in `arkiv/schema.md` rather than dressed up.

Expired entities: the Mission 02 entity above is no longer queryable. Its receipt,
block heights and the historic `atBlock` read are preserved here and in
`arkiv/missions.md`.

---

# Known limitations

- Contracts ARE deployed to Fuji: `InvoiceClaim`
  `0x6eCeaF4c89cFE03093Ebc55c2B750386c88c7cC0`, `FUSD`
  `0xe21305727CE87e3Aa84D187080F8A828dB1b480E`, in transaction
  `0x90b7e8f5e96aeee4ca40e14fa089a584f9d3d91202a448ede97c26e336882e3d`.
  Deployed from a browser wallet with no exportable private key, because
  `forge script` needs one and the operator's wallet does not provide one.
- `NEXT_PUBLIC_FIN1_ADDR` / `FIN2_ADDR` are unset, so demo quotes stand in the
  name of a labelled placeholder address; the sale path refuses a placeholder
  with the reason rather than reverting on chain.
- Swarm uploads need a postage batch, so `canUpload` is false without a gift code.
- No default handling at settlement: this is a market mechanism, not a credit
  product.
- Ranking is client-side because Arkiv has no ORDER BY. Fine at 50 rows, wrong at
  5,000; noted in the feedback report.
- ENS is the thinnest layer.

# Third-party components and prior work

No pre-existing project; all code written during the event. Third-party:
`@arkiv-network/sdk`, `@snaha/swarm-id`, `viem`, `next`, `react`,
OpenZeppelin v5, `forge-std`.
