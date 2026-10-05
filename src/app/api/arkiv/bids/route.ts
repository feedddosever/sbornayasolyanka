/**
 * Arkiv bid endpoints.
 *
 * Writes happen server-side because an Arkiv entity is owned by the wallet that
 * signs it, and those signing keys must not reach the browser. This also keeps
 * the browser wallet pinned to Fuji, so nobody is asked to switch networks
 * during a demo.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAddress, isHex, verifyTypedData } from "viem";
import { postBid, liveBidsFor, type SignedBidWire } from "@/arkiv/bids";
import { cleanKey } from "@/arkiv/client";
import type { Sector } from "@/arkiv/schema";
import { BID_TYPES, CLAIM_ADDRESS, bidDomain, fromFusd } from "@/fuji/claim";

/** Longest lifetime this server will pay to index. A bid is a quote, not a
 *  standing order, and every second of it is GLM spent by Factor's key. */
const MAX_BID_TTL_SECONDS = 3600;

/** GET /api/arkiv/bids?invoiceId=1&maxDiscountBps=800 */
export async function GET(req: NextRequest) {
  const invoiceId = req.nextUrl.searchParams.get("invoiceId");
  const maxBps = Number(req.nextUrl.searchParams.get("maxDiscountBps") ?? 10_000);
  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId required" }, { status: 400 });
  }

  try {
    const bids = await liveBidsFor(BigInt(invoiceId), maxBps);
    return NextResponse.json({
      bids: bids.map((b) => ({
        ...b,
        invoiceId: b.invoiceId.toString(),
        expiresAtBlock: b.expiresAtBlock.toString(),
      })),
      queriedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/arkiv/bids
 *   { invoiceId, financierSlot: 1|2, discountBps, sector, ensName,
 *     signed: { bid: { id, buyer, price, deadline, salt }, signature } }
 *
 * The bid must carry the financier's EIP-712 signature over the on-chain
 * `Bid`, and it is checked here before anything is written. Two things follow:
 * nobody can post a quote in a financier's name without their wallet, and the
 * price, the buyer and the lifetime that get indexed are the ones that were
 * SIGNED, not whatever else the request body says.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const checked = await checkSigned(body);
  if ("error" in checked) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }
  const { signed, price, deadline } = checked;

  // The entity lives until the signed deadline, so the index never shows a
  // quote the contract would refuse. Even, because the SDK requires a
  // multiple of the 2s block.
  const remaining = Number(deadline) - Math.floor(Date.now() / 1000);
  const ttlSeconds = remaining - (remaining % 2);
  if (ttlSeconds < 2) {
    return NextResponse.json({ error: "bid deadline has already passed" }, { status: 400 });
  }
  if (ttlSeconds > MAX_BID_TTL_SECONDS) {
    return NextResponse.json(
      { error: `bid deadline is more than ${MAX_BID_TTL_SECONDS}s away` },
      { status: 400 },
    );
  }

  // ONE FUNDED KEY IS ENOUGH.
  //
  // Whose bid this is comes from the `financier` ATTRIBUTE, not from `$owner`
  // — the signing key is Factor's either way, because keys stay server-side.
  // So the slot only picks a signer when more than one is configured; with a
  // single funded wallet every row is written by it and nothing downstream
  // cares. See the note on myLiveBids in src/arkiv/bids.ts.
  const preferred =
    body.financierSlot === 2 ? process.env.ARKIV_FIN2_PK : process.env.ARKIV_FIN1_PK;
  const pk =
    cleanKey(preferred) ||
    cleanKey(process.env.ARKIV_FIN1_PK) ||
    cleanKey(process.env.ARKIV_ISSUER_PK);

  if (!pk) {
    return NextResponse.json(
      {
        error:
          "No Arkiv signing key configured. Set ARKIV_FIN1_PK (one funded " +
          "Tiramisu key is enough; ARKIV_FIN2_PK and ARKIV_ISSUER_PK are optional).",
      },
      { status: 500 },
    );
  }

  try {
    const { entityKey, txHash } = await postBid(
      pk,
      {
        invoiceId: BigInt(signed.bid.id),
        financier: signed.bid.buyer,
        discountBps: Number(body.discountBps),
        offerPrice: fromFusd(price),
        sector: body.sector as Sector,
        ensName: String(body.ensName ?? ""),
        ttlSeconds,
      },
      signed,
    );

    return NextResponse.json({ entityKey, txHash, ttlSeconds });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** Validate the signed bid's shape, that it is for this invoice, and that the
 *  named buyer really signed it. */
async function checkSigned(
  body: any,
): Promise<{ signed: SignedBidWire; price: bigint; deadline: bigint } | { error: string }> {
  if (!CLAIM_ADDRESS) return { error: "NEXT_PUBLIC_CLAIM_ADDRESS is not configured" };

  const b = body?.signed?.bid;
  const signature = body?.signed?.signature;
  if (!b || !isHex(signature)) return { error: "signed bid and signature required" };
  if (!isAddress(b.buyer)) return { error: "signed.bid.buyer is not an address" };
  if (!isHex(b.salt) || b.salt.length !== 66) return { error: "signed.bid.salt must be bytes32" };

  let id: bigint, price: bigint, deadline: bigint;
  try {
    id = BigInt(b.id);
    price = BigInt(b.price);
    deadline = BigInt(b.deadline);
  } catch {
    return { error: "signed.bid id, price and deadline must be integers" };
  }
  if (String(id) !== String(body.invoiceId)) {
    return { error: "signed bid is for a different invoice" };
  }

  const valid = await verifyTypedData({
    address: b.buyer,
    domain: bidDomain(CLAIM_ADDRESS),
    types: BID_TYPES,
    primaryType: "Bid",
    message: { id, buyer: b.buyer, price, deadline, salt: b.salt },
    signature,
  }).catch(() => false);
  if (!valid) return { error: "signature does not match the bid or its buyer" };

  return {
    signed: {
      bid: { id: String(id), buyer: b.buyer, price: String(price), deadline: String(deadline), salt: b.salt },
      signature,
    },
    price,
    deadline,
  };
}
