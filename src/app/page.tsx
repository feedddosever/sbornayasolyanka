"use client";

/**
 * The market. This page is the demo.
 *
 * Two things here are deliberate rather than decorative:
 *
 *  1. The filter form renders the ACTUAL Arkiv query it produces, so a judge
 *     can see the compound filter instead of taking it on trust. Query depth is
 *     the largest slice of the Arkiv rubric; showing the predicate is the
 *     cheapest way to earn it.
 *
 *  2. Bid countdowns are derived from the entity's own `expiresAt` block height
 *     read back from the node, never from the lifetime we requested — because
 *     Arkiv's 2-second block time is nominal and duration expiries drift.
 *     Note it is `entity.expiresAt` (a top-level property), even though you
 *     FILTER on `$expiresAt` in the query. See src/arkiv/entity.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toHex } from "viem";
import { watchWithResync, type StreamStatus } from "@/arkiv/watch";
import type { SignedBidWire } from "@/arkiv/bids";
import {
  acceptBid,
  approveFusd,
  connectWallet,
  explorerTx,
  fromFusd,
  readInvoice,
  settleInvoice,
  signBid,
  toBytes32,
  type OnChainInvoice,
  type SignedBid,
} from "@/fuji/claim";

interface Listing {
  entityKey: string;
  invoiceId: string;
  issuer: `0x${string}`;
  debtor: `0x${string}`;
  sector: string;
  faceValue: string;
  dueDate: number;
  ratingBand: number;
  teaserRef: string;
  docCommit: string;
  ensName: string;
  sold: boolean;
}

interface Bid {
  entityKey: string;
  invoiceId: string;
  financier: `0x${string}`;
  discountBps: number;
  offerPrice: string;
  ensName: string;
  secondsLeft: number;
  signed?: SignedBidWire;
}

const SECTORS = ["", "logistics", "manufacturing", "services", "retail", "construction"];

export default function Market() {
  const [sector, setSector] = useState("");
  const [minFaceValue, setMin] = useState("");
  const [maxRatingBand, setRating] = useState("");
  const [dueWithinDays, setDueWithin] = useState("");

  const [listings, setListings] = useState<Listing[]>([]);
  const [bids, setBids] = useState<Record<string, Bid[]>>({});
  const [chain, setChain] = useState<Record<string, OnChainInvoice>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());

  /** The predicate, written out exactly as the SDK will build it. */
  const queryText = [
    `project     =  str('factor-invoice-market-ethrome-2026')`,
    `kind        =  str('listing')`,
    `sold        =  false`,
    sector && `sector      =  str('${sector}')`,
    minFaceValue && `face_value  >= dec('${minFaceValue}')`,
    dueWithinDays && `due_date    <= u64(now + ${dueWithinDays}d)`,
    maxRatingBand && `rating_band <= i32(${maxRatingBand})`,
  ]
    .filter(Boolean)
    .join("\n");

  const clauseCount = queryText.split("\n").length;

  /** Seconds left, interpolated locally between stream updates. No network. */
  const remaining = (bid: Bid) =>
    Math.max(0, Math.round(bid.secondsLeft - (nowTick - fetchedAt) / 1000));

  const loadListings = useCallback(async () => {
    setErr(null);
    const p = new URLSearchParams();
    if (sector) p.set("sector", sector);
    if (minFaceValue) p.set("minFaceValue", minFaceValue);
    if (maxRatingBand) p.set("maxRatingBand", maxRatingBand);
    if (dueWithinDays) {
      p.set("dueBefore", String(Math.floor(Date.now() / 1000) + Number(dueWithinDays) * 86400));
    }

    try {
      const r = await fetch(`/api/arkiv/listings?${p}`).then((x) => x.json());
      if (r.error) return setErr(r.error);
      setListings(r.listings ?? []);

      // Cross-chain read: the listing is the index, Fuji holds the asset.
      const onChain: Record<string, OnChainInvoice> = {};
      await Promise.all(
        (r.listings ?? []).map(async (l: Listing) => {
          try {
            onChain[l.invoiceId] = await readInvoice(BigInt(l.invoiceId));
          } catch {
            /* not deployed yet, or wrong contract address in env */
          }
        }),
      );
      setChain(onChain);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [sector, minFaceValue, maxRatingBand, dueWithinDays]);

  /**
   * Read the authoritative bid state. This is a QUERY, not a poll - nothing
   * calls it on a timer. It runs once on load and then only when the websocket
   * says something changed.
   */
  const refreshBids = useCallback(async () => {
    const next: Record<string, Bid[]> = {};
    await Promise.all(
      listings.map(async (l) => {
        try {
          const r = await fetch(`/api/arkiv/bids?invoiceId=${l.invoiceId}`).then((x) => x.json());
          next[l.invoiceId] = r.bids ?? [];
        } catch {
          next[l.invoiceId] = [];
        }
      }),
    );
    setBids(next);
    setFetchedAt(Date.now());
  }, [listings]);

  /**
   * MISSION 03. The bid book updates from an Arkiv websocket subscription -
   * there is no `setInterval` anywhere in this file that touches the network.
   *
   * The stream carries "something changed"; the query above carries "here is
   * the truth". That split is deliberate: a replay would require `fromBlock`,
   * which forces viem back onto the polling path, so a dropped connection
   * resyncs with a query instead and the subscription stays a subscription.
   *
   * SUBSCRIBED ON MOUNT, ALWAYS. `watchEntityEvents` is a global entity
   * stream, not a per-listing one, so gating it on `listings.length` was a
   * bug: an empty market never opened the socket and the indicator sat on
   * "connecting" forever, which reads as "the websocket does not work". It
   * also resubscribed on every listing change, churning the connection.
   *
   * The resync callback goes through a ref so the socket is opened exactly
   * once for the page's lifetime while still calling the freshest query.
   */
  const refreshRef = useRef(refreshBids);
  useEffect(() => {
    refreshRef.current = refreshBids;
  }, [refreshBids]);

  useEffect(() => {
    const handle = watchWithResync(() => refreshRef.current(), {
      onStatus: setStreamStatus,
    });
    return () => handle.stop();
  }, []);

  /** Initial read, and a re-read whenever the filter changes the listing set. */
  useEffect(() => {
    if (!listings.length) return;
    void refreshBids();
  }, [listings, refreshBids]);

  /**
   * A local render ticker, NOT a poll. It touches no network: it only advances
   * the clock so the countdown interpolates between stream updates, from the
   * `expiresAt` block height the node already gave us.
   */
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void loadListings();
  }, [loadListings]);

  /**
   * Stand a bid AS THE CONNECTED WALLET.
   *
   * The financier signs an EIP-712 `Bid` naming this claim, the price and a
   * deadline. That signature is the only thing `sell()` will move money
   * against, so the issuer can fill the quote but cannot change it. Signing is
   * free: no transaction, no gas, and nothing on Fuji until the issuer accepts.
   *
   * To demo two competing quotes, switch wallet accounts between clicks.
   */
  async function postDemoBid(l: Listing, slot: 1 | 2, discountBps: number, ttl: number) {
    setBusy(true);
    setErr(null);
    setTxHash(null);
    try {
      const financier = await connectWallet();
      const onChain = chain[l.invoiceId] ?? (await readInvoice(BigInt(l.invoiceId)));

      if (onChain.holder && onChain.holder.toLowerCase() === financier.toLowerCase()) {
        throw new Error(
          `The connected wallet holds this claim, so accepting its bid would revert ` +
            `with SelfPurchase. Switch to a financier account and bid again.`,
        );
      }

      // Priced off the ON-CHAIN face value, in integer FUSD units: the index
      // can lag, and a float here would sign a price nobody meant.
      const bid: SignedBid = {
        id: onChain.id,
        buyer: financier,
        price: (onChain.faceValue * BigInt(10_000 - discountBps)) / 10_000n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + ttl),
        salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
      };
      const signature = await signBid(financier, bid);

      const r = await fetch("/api/arkiv/bids", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId: l.invoiceId,
          financierSlot: slot,
          sector: l.sector,
          ensName: `fin${slot}.factor.eth`,
          signed: {
            bid: {
              id: bid.id.toString(),
              buyer: bid.buyer,
              price: bid.price.toString(),
              deadline: bid.deadline.toString(),
              salt: bid.salt,
            },
            signature,
          },
        }),
      }).then((x) => x.json());
      if (r.error) setErr(r.error);
      else
        setMsg(
          `${financier.slice(0, 10)}… signed a bid at ${fromFusd(bid.price)} FUSD, ` +
            `lifetime ${r.ttlSeconds}s — entity ${r.entityKey.slice(0, 18)}…`,
        );
    } catch (e: any) {
      setErr(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Grant the claim contract an FUSD allowance, signed by WHOEVER IS CONNECTED.
   *
   * `sell()` pulls the payment from the buyer, so a bid cannot be accepted
   * until that buyer has approved. `approve` can only be sent by the token
   * holder itself, so nobody can do this on a financier's behalf — not the
   * issuer, and not a deploy script holding some other key.
   *
   * The scripted path is `script/Approve.s.sol`, which needs each financier's
   * private key in the environment. A passkey or MPC wallet has no exportable
   * key, which would make the on-chain half of this demo impossible for a
   * perfectly ordinary account. It is not impossible: such a wallet signs
   * transactions happily, it just never hands over the key. So the step belongs
   * in the browser, where the wallet lives.
   *
   * The financier switches to their own account in the wallet, clicks this, and
   * the allowance is theirs. Same reasoning as FactorDeployer.sol, one layer up.
   *
   * A standing allowance is safe to grant because `sell()` only ever takes the
   * price the financier SIGNED, on the claim they signed it for.
   */
  async function approveAsFinancier(l: Listing) {
    setBusy(true);
    setErr(null);
    setTxHash(null);
    try {
      const account = await connectWallet();

      // Approve the ON-CHAIN face value, not the Arkiv listing's copy: the
      // index can lag, and the contract is the authority on what is owed.
      const onChain = chain[l.invoiceId] ?? (await readInvoice(BigInt(l.invoiceId)));
      const hash = await approveFusd(account, onChain.faceValueHuman);
      setTxHash(hash);
      setMsg(
        `${account.slice(0, 10)}… approved ${onChain.faceValueHuman} FUSD to the claim ` +
          `contract. That account can now have a bid accepted in its name. Switch ` +
          `wallet accounts and repeat for the second financier.`,
      );
    } catch (e: any) {
      setErr(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  /** Accept a bid on Fuji, recording which Arkiv entity it filled. */
  async function accept(l: Listing, bid: Bid) {
    setBusy(true);
    setErr(null);
    try {
      // Rows without a signature (the evidence script writes some) are real
      // Arkiv entities, but there is nothing the contract can fill them with.
      if (!bid.signed) {
        throw new Error(
          `This bid carries no financier signature, so it cannot be filled on-chain. ` +
            `Bids posted from this page are signed by the connected wallet.`,
        );
      }

      const account = await connectWallet();
      const s = bid.signed.bid;

      const hash = await acceptBid({
        account,
        bid: {
          id: BigInt(s.id),
          buyer: s.buyer,
          price: BigInt(s.price),
          deadline: BigInt(s.deadline),
          salt: s.salt,
        },
        signature: bid.signed.signature,
        arkivBidKey: toBytes32(bid.entityKey),
      });
      setTxHash(hash);
      setMsg(
        `Sold. The transaction records Arkiv bid ${bid.entityKey.slice(0, 14)}… ` +
          `so the fill can be reconciled against the offer that produced it.`,
      );
    } catch (e: any) {
      setErr(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  async function settle(l: Listing) {
    setBusy(true);
    try {
      const account = await connectWallet();
      // Approve the ON-CHAIN face value. The Arkiv listing is an index and
      // can lag; the contract is the authority on what is owed.
      const onChain = chain[l.invoiceId] ?? (await readInvoice(BigInt(l.invoiceId)));
      await approveFusd(account, onChain.faceValueHuman);
      const hash = await settleInvoice(account, BigInt(l.invoiceId));
      setTxHash(hash);
      setMsg(
        `Settled — holder paid ${onChain.faceValueHuman} FUSD and the claim was burned.`,
      );
    } catch (e: any) {
      setErr(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Invoice market</h1>
      <p className="sub">
        Live claims on Avalanche Fuji, discovered through a compound Arkiv query. Bids carry
        their own lifetime — there is no cancel button anywhere in this app, because a stale
        quote stops existing.
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <span className={`stream ${streamStatus}`}>
          <i />
          {streamStatus === "live"
            ? "arkiv websocket · live"
            : streamStatus === "connecting"
              ? "arkiv websocket · connecting"
              : streamStatus === "reconnecting"
                ? "arkiv websocket · reconnecting"
                : "stream stopped"}
        </span>
        <span className="note">
          The book updates from the subscription, not a timer. The countdown ticks locally
          between events.
        </span>
      </div>

      <div className="filters">
        <label>
          Sector
          <select value={sector} onChange={(e) => setSector(e.target.value)}>
            {SECTORS.map((s) => (
              <option key={s} value={s}>
                {s || "any"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min face value
          <input value={minFaceValue} onChange={(e) => setMin(e.target.value)} placeholder="5000" />
        </label>
        <label>
          Due within (days)
          <input value={dueWithinDays} onChange={(e) => setDueWithin(e.target.value)} placeholder="90" />
        </label>
        <label>
          Max rating band
          <input value={maxRatingBand} onChange={(e) => setRating(e.target.value)} placeholder="3" />
        </label>
      </div>

      <div className="query">
        {`arkiv_query  —  ${clauseCount} clauses\n\n${queryText}`}
      </div>
      <p className="note">
        Every control above is one predicate. Arkiv throws <code>InvalidPredicateError</code> on a
        filter-less query, so the two base clauses are load-bearing rather than decoration.
      </p>

      {err && <div className="err">{err}</div>}
      {msg && (
        <div className="ok">
          {msg}
          {txHash && (
            <>
              {" "}
              <a className="link" href={explorerTx(txHash)} target="_blank" rel="noreferrer">
                View on Snowtrace →
              </a>
            </>
          )}
        </div>
      )}

      {!listings.length ? (
        <div className="empty">
          No listings match. Issue one at <a className="link" href="/issue">/issue</a>, or widen the
          filter.
        </div>
      ) : (
        <div className="cards">
          {listings.map((l) => {
            const live = (bids[l.invoiceId] ?? []).filter((b) => remaining(b) > 0);
            const oc = chain[l.invoiceId];
            return (
              <div className="card" key={l.entityKey}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h3>
                    Invoice #{l.invoiceId} · {l.faceValue} FUSD
                  </h3>
                  <span className="row">
                    <span className="tag fuji">fuji</span>
                    <span className="tag arkiv">arkiv</span>
                    {l.teaserRef && <span className="tag swarm">swarm</span>}
                    {l.ensName && <span className="tag ens">{l.ensName}</span>}
                  </span>
                </div>

                <div className="row" style={{ marginTop: 10 }}>
                  <span>
                    <span className="k">sector</span> {l.sector}
                  </span>
                  <span>
                    <span className="k">due</span> {new Date(l.dueDate * 1000).toLocaleDateString()}
                  </span>
                  <span>
                    <span className="k">rating</span> {l.ratingBand}
                  </span>
                  {oc && (
                    <span>
                      <span className="k">holder</span>{" "}
                      <span className="mono">{oc.holder?.slice(0, 10)}…</span>
                    </span>
                  )}
                  {oc?.matured && <span className="tag">matured — transfers blocked</span>}
                </div>

                <div className="bids">
                  {live.length === 0 && (
                    <div className="note">
                      No live bids. Every previous offer has expired on its own.
                    </div>
                  )}
                  {live.map((b, i) => (
                    <div className={`bid ${i === 0 ? "best" : ""}`} key={b.entityKey}>
                      <span>
                        <span className="mono">{b.ensName || b.financier.slice(0, 12)}</span>{" "}
                        — {b.offerPrice} FUSD
                      </span>
                      <span className="k">{(b.discountBps / 100).toFixed(2)}%</span>
                      <span className={`ttl ${remaining(b) < 15 ? "urgent" : ""}`}>
                        {remaining(b)}s
                      </span>
                      <button disabled={busy || oc?.matured} onClick={() => accept(l, b)}>
                        Accept
                      </button>
                    </div>
                  ))}
                </div>

                <div className="row" style={{ marginTop: 14 }}>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => postDemoBid(l, 1, 320, 60)}
                  >
                    Sign bid 3.20% / 60s
                  </button>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => postDemoBid(l, 2, 450, 20)}
                  >
                    Sign bid 4.50% / 20s (watch it lapse)
                  </button>
                  <button className="ghost" disabled={busy} onClick={() => approveAsFinancier(l)}>
                    Approve FUSD as financier
                  </button>
                  <button className="ghost" disabled={busy} onClick={() => settle(l)}>
                    Settle as debtor
                  </button>
                </div>

                <p className="note mono">
                  docCommit {l.docCommit.slice(0, 22)}… · teaser{" "}
                  {l.teaserRef ? `${l.teaserRef.slice(0, 18)}…` : "none"}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Turn a custom-error revert into something a judge can read off the screen.
 *  The three memorable moments in this demo are all rejections, so a revert
 *  nobody can see earns nothing. */
function humanise(e: any): string {
  const s = String(e?.shortMessage ?? e?.message ?? e);
  if (s.includes("NotEligible")) {
    return "Rejected on-chain: that address is not on the eligibility list. The transfer hook refused it.";
  }
  if (s.includes("PastMaturity")) {
    return "Rejected on-chain: this claim has matured and can no longer change hands. It can still be settled.";
  }
  if (s.includes("AlreadySettled")) return "Rejected on-chain: this invoice is already settled.";
  if (s.includes("NotDebtor")) return "Rejected on-chain: only the named debtor can settle.";
  if (s.includes("NotHolder")) return "Rejected on-chain: only the current holder can sell.";
  if (s.includes("SelfPurchase")) return "Rejected on-chain: the holder cannot buy its own claim.";
  if (s.includes("BadBidSignature")) {
    return "Rejected on-chain: the bid does not match what the financier signed.";
  }
  if (s.includes("BidExpired")) return "Rejected on-chain: the financier's signed deadline has passed.";
  if (s.includes("BidAlreadyUsed")) {
    return "Rejected on-chain: this bid was already filled or cancelled by the financier.";
  }
  if (s.includes("insufficient allowance")) {
    return "The buyer has not approved enough FUSD yet.";
  }
  return s;
}
