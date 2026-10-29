/**
 * Arkiv bid endpoints.
 *
 * Writes happen server-side because an Arkiv entity is owned by the wallet that
 * signs it, and those signing keys must not reach the browser. This also keeps
 * the browser wallet pinned to Fuji, so nobody is asked to switch networks
 * during a demo.
 */
import { NextRequest, NextResponse } from "next/server";
import { postBid, liveBidsFor } from "@/arkiv/bids";
import { cleanKey } from "@/arkiv/client";
import type { Sector, SignedBidWire } from "@/arkiv/schema";
import { fromFusd } from "@/fuji/claim";

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

/** POST /api/arkiv/bids  { invoiceId, financierSlot: 1|2, discountBps, offerPrice, sector, ensName, signedBid? } */
export async function POST(req: NextRequest) {
  const body = await req.json();

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

  // Keep demo lifetimes short and even. Short because nobody can wait on
  // Sunday morning; even because the SDK requires a multiple of the 2s block.
  const requested = Number(body.ttlSeconds ?? 60);
  const ttlSeconds = Math.max(2, requested - (requested % 2));

  // A signed bid is the source of truth for whose offer this is, on which
  // claim, at what price - so the queryable attributes are taken from it, and
  // the book can never list terms other than the ones `sell()` would execute.
  const signed: SignedBidWire | undefined = body.signedBid ?? undefined;

  try {
    const { entityKey, txHash } = await postBid(pk, {
      invoiceId: BigInt(signed?.claimId ?? body.invoiceId),
      financier: signed?.buyer ?? body.financier,
      discountBps: Number(body.discountBps),
      offerPrice: signed ? fromFusd(BigInt(signed.price)) : String(body.offerPrice),
      sector: body.sector as Sector,
      ensName: String(body.ensName ?? ""),
      ttlSeconds,
      signed,
    });

    return NextResponse.json({ entityKey, txHash, ttlSeconds });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
