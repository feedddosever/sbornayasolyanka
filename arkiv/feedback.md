# Arkiv feedback — Factor, ETHRome 2026

*Nine items, each reproduced against `@arkiv-network/sdk` on Tiramisu, plus what
worked and one process note. Two of the nine are bugs of my own, kept because
how they were found is the transferable part.*

*What worked, what got in the way, and what I'd change.* Everything below was
reproduced against `@arkiv-network/sdk` on Tiramisu (chain 7738577) while
building [Factor](./README.md).

**A note on how this list was built, because it is itself feedback.** My first
draft contained five confident bug reports that turned out to be wrong — I had
been guessing documentation URLs (`/sdk/quickstart`, `/sdk/query`) that don't
exist in your information architecture, and reading 404s as broken docs. The
real paths (`/start-here/installation/`, `/typescript-sdk/live-events/`,
`/networks/tiramisu/`) serve fine, have a full API reference, and include
"Copy Markdown" and "Open in Claude" affordances that are genuinely better than
most SDK docs I've used. I deleted those items rather than ship them. What's
left is verified, with repro steps.

For the record, `/sitemap-index.xml` does exist — I checked before writing this
sentence, having already been wrong once. So the docs are fine and the mistake
was mine. If there is a fix worth making it is a tiny one: a `404` page that
links the sitemap, or an `llms.txt`, so a bad guess lands somewhere useful
instead of a dead end.

---

## What got in the way

### 1. `Ident32` rejects uppercase; two places in the SDK promise it is allowed

**Severity: highest in this list. It is a hard blocker, and both of the things a
careful developer would consult point the wrong way.**

Writing a bid failed with:

```
Transaction failed: an attribute name holds "B" (0x42) at byte 8, which is
outside the name charset ("A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_",
with a letter first)
```

Byte 8 of `discountBps` is the capital `B`. **The message lists `"A"-"Z"` among
the permitted characters and then rejects one of them.** Read literally, it says
the name is invalid because it contains a valid character.

Chasing it through `dist/` (v0.8.1) shows why, and the cause is not the engine:

```js
// dist/index.js — the charset in the message is a fixed string
const CHARSET = '"A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_", with a letter first';

case "Ident32InvalidByte": {
  const position = Number(args[0] ?? 0);
  return `an attribute name holds ${printable(String(args[1] ?? "0x00"))} at byte ${position}, which is outside the name charset (${CHARSET})`;
}
```

```js
// dist/attr-*.js — the exported validator agrees with CHARSET, not with the engine
NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/
```

The engine reverts with `Ident32InvalidByte(uint256 position, bytes1 value)` —
precise, correct data, `(8, 0x42)`. The SDK then decodes it and substitutes a
hardcoded charset description that does not match `Ident32`'s actual rule. So:

- `isValidAttributeName("discountBps")` returns **`true`**. A developer who
  validates before writing — the careful thing to do — gets a false green light.
- The error message then describes a charset that would have permitted the name
  it just refused, so it reads as an SDK bug rather than as "rename your field".

**Credit where it is due:** the revert is caught at simulation, not after
broadcast. My signer's nonce stayed at 0 and its balance was untouched across
several failed writes, so nothing was wasted but time. The comment above
`describeEntityRevert` also says the engine's errors "carry enough to name the
actual problem, so this spends the args rather than printing them" — the intent
is clearly to be more helpful than a raw revert dump, and for the other twenty
or so branches it is. This one branch just happens to assert something false,
which is worse than printing nothing: a neutral `(8, 0x42)` would have sent me
to the byte immediately.

**What it cost.** Eleven of Factor's twenty attribute names were camelCase, so
every write failed and the market stayed empty. The visible symptom was
`listings: 0`, which reads as an unfunded signer or a broken query — not as a
naming problem. Queries kept succeeding throughout, because a query over a name
nothing can write simply matches nothing. Nothing upstream catches it: not
`tsc`, not the SDK's own validator, not a read.

**Repro.** One entity, one attribute:

```ts
isValidAttributeName("camelCase"); // true
await arkivWallet(pk).createEntity({
  attributes: { project: str("x"), camelCase: str("y") },
  expires: ExpirationTime.fromSeconds(60),
});
// reverts Ident32InvalidByte(5, 0x43)
```

**Fix, in order of value.**

1. Make the three agree. If `Ident32` is lowercase-only, then `NAME_RE` becomes
   `/^[a-z][a-z0-9._-]*$/` and `CHARSET` drops `"A"-"Z"`. Two one-line changes
   and this class of bug is gone, with `isValidAttributeName` catching it
   locally before a transaction is ever built.
2. Name the attribute in the message. `attribute "discountBps": uppercase is
   not permitted after position 0` would have ended this in ten seconds. The
   caller knows the names it just encoded, so this is available at the point of
   failure.
3. Say it in the docs. Every example in the best-practices guide is snake_case
   (`entity_type`, `proposal_key`), so the working convention is already there
   implicitly — one sentence would make it explicit.

Factor now uses snake_case throughout (`discount_bps`, `invoice_id`,
`face_value`), and the reason is recorded at the top of `src/arkiv/schema.ts` so
nobody reintroduces a camelCase name later.

### 2. The Live Events example builds exactly the thing Mission 03 disqualifies

**Severity: high — this one costs you bounty entries.**

`docs.arkiv.network/typescript-sdk/live-events/` says `watchEntityEvents`
"polls the chain for new events", defaults `pollingInterval` to half a block,
and its Basic Usage snippet constructs the client with `http()`.

Mission 03 requires updating "from the stream, without a polling loop". So a
developer who follows the documented example literally has built the
disqualifying implementation, and nothing on the page tells them. The fact that
you need a **websocket transport** — and that viem only opens `eth_subscribe`
when the transport can carry it — is only discoverable from the
`watchEvent#poll-optional` link on the ETHRome hub page, which is not linked
from the SDK docs.

**Repro:** follow the Live Events Basic Usage snippet verbatim; observe repeated
`eth_getFilterChanges`/`eth_getLogs` rather than a subscription.

**Suggested fix:** show `webSocket()` in the Basic Usage snippet, or add a
callout: *"with an `http` transport this polls; pass a `webSocket` transport for
a real subscription."* Also state explicitly what `fromBlock` does to the
transport choice — the interaction between "replay history" and "stay on a
socket" is the actual hard part of Mission 03, and it is currently folklore.

### 3. `fromBlock` and socket delivery are mutually exclusive, and that has no guidance

Recovering from a dropped connection wants a replay; a replay sets `fromBlock`;
`fromBlock` forces polling. So the obvious reconnection strategy silently
converts a subscription back into a loop.

This is a real architectural fork and the docs don't acknowledge it. Factor's
answer (in `src/arkiv/watch.ts`) is to resubscribe with no `fromBlock` and close
the gap with a one-shot query instead — the socket carries "something changed",
the query carries "here is the truth". **Suggested fix:** document that pattern,
or say plainly that `watchEntityEvents` is at-most-once and callers must
reconcile.

### 4. No sort and no aggregate, which caps what the query layer can be

**Severity: medium — this is the thing stopping Factor from being real.**

Typed attributes with real comparison operators are the reason to choose Arkiv,
but there is no `orderBy` and no `count`. Factor's bid book therefore fetches a
page and ranks client-side (`src/arkiv/bids.ts`). At 50 rows that is fine; for
an actual order book it is wrong, because the best bid might be on page three
and `MAX_LIMIT` is 200.

I can't express "the cheapest live bid on this invoice" — which is the single
most natural question in the entire domain — as a query.

**Suggested fix:** `orderBy` on an indexed attribute would unlock a large class
of apps. A `count`-only query mode would be a strong second.

### 5. The SDK exports three predicates the node refuses, and the obvious workaround is one of them

**Severity: high, and it is the same shape as item 1.**

`@arkiv-network/sdk` 0.8.1 exports `ne`, `exists` and `hasType`. Tiramisu
rejects all three:

```
!= is not part of the query language — write NOT (attr = value)
   for the complement                                            (-32002)
exists(…) is not supported — the index has no per-attribute
   presence set in this profile                                   (-32002)
hasType(…)                                    unexpected character (-32001)
```

The exports typecheck, autocomplete, and fail at query time. As in item 1, the
SDK's surface is wider than the chain it targets, and nothing local says so.

**What made this worse for me.** An earlier draft of this very report advised
using `not(exists(...))` as the fix for the `ne` trap below — advice I only
discovered was wrong when your own `check_schema` tool warned me, at which point
I tested the node directly. A tool in your MCP caught an error in my feedback
about your SDK, which is a good argument for that tool existing.

**The underlying `ne` trap is real and still worth documenting.**
`ne("sold", bool(true))` matches only entities where `sold` is *set* to
something else, so entities created before the attribute existed silently vanish
from results. No error, no warning, wrong answers.

**And the correct form has semantics worth stating explicitly.** Verified
against the node, for an entity with no `withdrawn` attribute at all:

| Query | Result |
|---|---|
| `NOT withdrawn = true` | **matches** |
| `NOT withdrawn = false` | **matches** |
| `withdrawn = true` | no match |

So absence satisfies the complement of any equality. That is almost certainly
what a developer writing "not withdrawn" wants, and it is the opposite of what
`ne` gives them. One sentence on the Querying Data page — "`NOT attr = value`
includes entities that do not have the attribute; `ne` does not" — would remove
the whole class of bug.

**Repro:** create an entity without attribute `x`. `ne("x", str("a"))` does not
return it; `not(eq("x", str("a")))` does. Then try `exists("x")` and watch it
fail with -32002.

**Suggested fixes.**

1. Make the exports match the profile, or have the SDK reject `ne` / `exists` /
   `hasType` locally with the node's own message. Failing at build time beats
   failing at query time.
2. Document the complement semantics next to `ne`, since that is the behaviour
   people actually need.
3. One more, smaller: the raw query language takes `bool` as a bare literal —
   `sold = false`, not `sold = bool(false)`, which returns
   `bool takes no wrapper` (-32003). The SDK's `bool()` helper renders this
   correctly, so it only bites when hand-writing a query for the Data Explorer
   after reading SDK code. A line in the query-language reference would cover it.

### 6. `--` in an attribute name writes fine, then corrupts queries

I named an attribute `rating--band`. The write succeeded. Every later query
filtering on it returned wrong results, because `--` opens a comment in the
query language and the rest of the predicate is discarded.

`validateAttributeName` / `isValidAttributeName` exist and I should have used
them — but the *consequence* is what makes this dangerous: the failure appears
at query time, in a different part of the codebase, looking like a query-engine
bug rather than a naming one.

**Suggested fix:** reject `--` at write time with an error that names the
reason ("`--` begins a comment in the query language"). Failing fast at the
write is strictly better than a silent read-time corruption.

### 7. Duration helpers read as wall-clock but aren't

`ExpirationTime.fromSeconds(60)` resolves to 30 blocks, which is 60 seconds only
if blocks are exactly 2s — and the docs are careful to say block production is
not a clock. That honesty is good; the API naming quietly undoes it, because
every helper is named in time units.

`getBlockTiming` exists, which is the right primitive — it just isn't mentioned
anywhere near the duration helpers.

**Suggested fix:** cross-link `getBlockTiming` from the expiry helpers, or have
them return the resolved target block so the drift is visible at the call site.
Factor now reads `$expiresAt` back and renders countdowns from block height
rather than from what it requested.

### 8. `fromSeconds` rejects odd numbers without saying why

`ExpirationTime.fromSeconds(45)` throws. The constraint (a positive multiple of
the 2-second block time) is reasonable, but it leaks block time into an API
presented in seconds, and the error doesn't say "must be even". Minor, but it's
a 30-second confusion for every new user.

---

### 9. Filtering a field and reading it are different, and nothing says so

**Severity: low, and the bug was mine. Included because the shape of it is the
useful part.**

`$expiresAt` is filterable, which is the whole basis of Mission 02's "live bids
are a predicate" argument. So this query looks complete:

```ts
arkivPublic
  .select({ key: true, attributes: true, payload: true })
  .where(eq("kind", str("bid")), gt("$expiresAt", u64(block)))
```

It is complete, and it works. The engine evaluates `$expiresAt` server-side and
has no reason to return a field nobody asked for — which is correct behaviour.
But my code then read `entity.expiresAt` to render a countdown, got `undefined`,
and my own accessor substituted a default. Every countdown on the page rendered
`0` while the bids themselves lived and expired perfectly.

**Why it took an hour.** Filtering kept working, so the data was right. Expiry
kept working, so the mechanism was right. The only wrong thing was a number on
a screen, and a zero is a plausible number. There was no error anywhere, because
nothing had failed.

**Repro.** Query with a predicate on `$expiresAt` and a selection that omits it.
Read `entity.expiresAt`. It is `undefined`.

**The suggestion, and it is small.** A query that filters on a field it does not
select is almost always a mistake — the developer is thinking about that field.
A development-mode warning would catch it at the point of construction:

```
predicate references $expiresAt, which is not in select(). Filtering a field
does not return it — add `expiresAt: true` if you intend to read it.
```

One sentence in the querying docs would do nearly as well. The reason I am
reporting my own bug is that the same sentence would have saved the hour, and
because the class of failure — every layer reports success, the result is still
wrong — is the one your platform is hardest to debug for.

## What worked

Worth recording, because a report with no positives is less useful to you.

- **`.atBlock()` is the best thing in the SDK and it is undersold.** Point-in-time
  historic reads turned "prove the data expired on its own" from a screen
  recording into a two-line script that runs identically on demand
  (`scripts/evidence.ts`: one query, two block heights, present then absent).
  Nothing in the Mission 02 brief mentions it, and it is the single most
  compelling way to satisfy that mission's evidence requirement. Lead with it.
- **The query builder composes cleanly.** `.where(eq(...), gte(...))` ANDing
  together, with `ownedBy()` as sugar for `$owner`, reads well and the types
  caught two mistakes before runtime.
- **Typed attributes are the actual differentiator.** `dec` for money instead of
  a stringly-typed amount is the right call, and range filters over `dec`/`u64`
  are what make an index worth having over a key-value store.
- **Being a viem client** meant accounts, transports and error handling were
  already familiar — zero new concepts before the first entity.
- **The docs' "Copy Markdown" / "Open in Claude" buttons** are excellent and rare.
  Pair them with an `llms.txt` and the programmatic story would be best-in-class.
- **`predictEntityKey` / `randomSalt`** are a nice surprise — being able to know
  an entity's key before creating it opens coordination patterns I didn't expect
  and didn't have time to use.

---

## One process note, not about the SDK

The judging criteria on `hub.arkiv.network/ethrome` and the ones on the ETHRome
prizes page are materially different sets — the ETHRome page lists query depth,
evidence, schema trade-offs, friction and craft; your page lists why-Arkiv,
technical execution, usefulness/adoption and feedback. I built against your
page, since the ETHRome manual says yours is authoritative and kept current.
Worth reconciling before Sunday so nobody optimises for the wrong rubric.

Your page also links its own submission form, which the ETHRome page does not
mention. I have filled in both.
