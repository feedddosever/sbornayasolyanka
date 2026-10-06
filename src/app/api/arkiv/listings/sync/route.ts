/**
 * POST /api/arkiv/listings/sync  { invoiceId }
 *
 * Bring a listing's `sold` flag in line with Fuji. Nothing else ever set it,
 * so sold claims stayed in the market until maturity plus a week, and the
 * `sold = false` clause in discovery filtered nothing.
 *
 * Anyone may call this, because it takes no claim from the caller: the chain
 * decides. A listing is sold once the claim's holder is no longer the seller
 * the listing recorded (`holder`), or the claim has been settled and burned.
 * While the seller still holds it, the call changes nothing. Idempotent, so
 * the market page can fire it after every sale or settlement.
 */
import { NextRequest, NextResponse } from "next/server";
import { cleanKey } from "@/arkiv/client";
import { asAddress } from "@/arkiv/entity";
import { listingIsSold, markListingSold, openListingFor } from "@/arkiv/listings";
import { CLAIM_ADDRESS, readInvoice } from "@/fuji/claim";
import { asUint, bad, jsonBody, rateLimit } from "@/server/guard";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "listings-sync", { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const b = await jsonBody(req);
  if (b instanceof NextResponse) return b;
  if (!CLAIM_ADDRESS) return bad("NEXT_PUBLIC_CLAIM_ADDRESS is not configured", 500);
  const id = asUint(b.invoiceId);
  if (id === undefined || id === 0n) return bad("invoiceId must be a positive integer");

  let listing: any;
  try {
    listing = await openListingFor(id);
  } catch (e: any) {
    return bad(`could not read the Arkiv index: ${e?.message}`, 502);
  }
  if (!listing) return NextResponse.json({ sold: true, changed: false, note: "no unsold listing" });

  let inv;
  try {
    inv = await readInvoice(id);
  } catch (e: any) {
    return bad(`could not read invoice ${id} on Fuji: ${e?.shortMessage ?? e?.message}`, 502);
  }

  const a = listing.attributes ?? {};
  const recorded = {
    holder: a.holder === undefined ? undefined : asAddress(a.holder),
    issuer: asAddress(a.issuer),
  };
  if (!listingIsSold(recorded, inv)) return NextResponse.json({ sold: false, changed: false });
  const gone = !inv.holder || inv.settled;

  // Signed by the key that wrote the listing, which is the only one Arkiv
  // will accept a patch from.
  const pk = cleanKey(process.env.ARKIV_ISSUER_PK) || cleanKey(process.env.ARKIV_FIN1_PK);
  if (!pk) return bad("No Arkiv signing key configured. Set ARKIV_ISSUER_PK or ARKIV_FIN1_PK.", 500);

  try {
    const { txHash } = await markListingSold(pk, listing.key);
    return NextResponse.json({ sold: true, changed: true, reason: gone ? "settled" : "sold", txHash });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
