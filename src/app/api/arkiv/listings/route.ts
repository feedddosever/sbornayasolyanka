import { NextRequest, NextResponse } from "next/server";
import { isHex, verifyTypedData } from "viem";
import { discover, openListingFor, publishListing } from "@/arkiv/listings";
import { cleanKey } from "@/arkiv/client";
import { isSector } from "@/arkiv/schema";
import { CLAIM_ADDRESS, LISTING_TYPES, bidDomain, readInvoice } from "@/fuji/claim";
import { asUint, bad, isEnsName, isPublicSwarmRef, jsonBody, rateLimit } from "@/server/guard";
import { ensNameIsOwnedBy } from "@/ens/verify";
import {
  asAddress,
  asBigInt,
  asBool,
  asDecimalString,
  asNumber,
  asString,
  meta,
} from "@/arkiv/entity";

/**
 * GET /api/arkiv/listings?sector=logistics&minFaceValue=5000&dueBefore=...&maxRatingBand=3
 *
 * Every parameter here maps to one clause of the compound query, so the filter
 * form in the UI *is* the query builder.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  const sector = p.get("sector") || undefined;
  if (sector !== undefined && !isSector(sector)) return bad("unknown sector");
  const dueBefore = p.get("dueBefore") ? asUint(p.get("dueBefore")) : undefined;
  if (p.get("dueBefore") && dueBefore === undefined) return bad("dueBefore must be unix seconds");
  const maxRatingBand = p.get("maxRatingBand") ? Number(p.get("maxRatingBand")) : undefined;
  if (maxRatingBand !== undefined && !(Number.isInteger(maxRatingBand) && maxRatingBand >= 1 && maxRatingBand <= 5)) {
    return bad("maxRatingBand must be 1..5");
  }
  for (const k of ["minFaceValue", "maxFaceValue"]) {
    const v = p.get(k);
    if (v && !/^\d{1,18}(\.\d{1,6})?$/.test(v)) return bad(`${k} must be a decimal amount`);
  }

  try {
    const page = await discover({
      sector,
      minFaceValue: p.get("minFaceValue") ?? undefined,
      maxFaceValue: p.get("maxFaceValue") ?? undefined,
      dueBefore,
      maxRatingBand,
    });

    return NextResponse.json({
      blockNumber: page.blockNumber?.toString(),
      // Attribute values come back TAGGED, not bare, so every field goes
      // through an unwrapping accessor. Reading them directly yields
      // "[object Object]" in the UI - see src/arkiv/entity.ts.
      listings: page.entities.map((e: any) => {
        const a = e.attributes ?? {};
        return {
          entityKey: e.key,
          invoiceId: asBigInt(a.invoice_id).toString(),
          issuer: asAddress(a.issuer),
          debtor: asAddress(a.debtor),
          sector: asString(a.sector),
          faceValue: asDecimalString(a.face_value),
          dueDate: asNumber(a.due_date),
          ratingBand: asNumber(a.rating_band),
          teaserRef: asString(a.teaser_ref),
          docCommit: asString(a.doc_commit),
          ensName: asString(a.ens_name),
          ensVerified: asBool(a.ens_verified),
          sold: asBool(a.sold),
          expiresAtBlock: meta(e).expiresAt.toString(),
        };
      }),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/arkiv/listings — publish the queryable shadow of an on-chain claim.
 *
 *   { invoiceId, sector, ratingBand, teaserRef, ensName, signature }
 *
 * Every write here is paid for by Factor's key, so a listing has to earn it:
 *
 *   - the claim must exist on Fuji, be outstanding and not yet matured
 *   - the CURRENT HOLDER must have signed the descriptive terms (EIP-712), so
 *     nobody can list someone else's invoice under a better name or rating
 *   - issuer, debtor, face value, due date and the document commitment are
 *     read from the chain, never from the body, so the index cannot disagree
 *     with the asset it points at
 *   - one unsold listing per invoice; a new holder may list it again
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "listings", { limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  const b = await jsonBody(req);
  if (b instanceof NextResponse) return b;

  if (!CLAIM_ADDRESS) return bad("NEXT_PUBLIC_CLAIM_ADDRESS is not configured", 500);
  const id = asUint(b.invoiceId);
  if (id === undefined || id === 0n) return bad("invoiceId must be a positive integer");
  if (!isSector(b.sector)) return bad("unknown sector");
  const ratingBand = Number(b.ratingBand);
  if (!Number.isInteger(ratingBand) || ratingBand < 1 || ratingBand > 5) {
    return bad("ratingBand must be 1..5");
  }
  const teaserRef = b.teaserRef ?? "";
  if (!isPublicSwarmRef(teaserRef)) {
    return bad(
      "teaserRef must be an unencrypted (64-hex) Swarm reference. An encrypted " +
        "reference carries its decryption key and must never be published.",
    );
  }
  const ensName = b.ensName ?? "";
  if (!isEnsName(ensName)) return bad("ensName is not a valid ENS name");
  if (!isHex(b.signature)) return bad("signature required");

  // The asset is the authority. Everything below comes from Fuji.
  let inv;
  try {
    inv = await readInvoice(id);
  } catch (e: any) {
    return bad(`could not read invoice ${id} on Fuji: ${e?.shortMessage ?? e?.message}`, 502);
  }
  if (!inv.holder || inv.settled) return bad(`invoice ${id} is not outstanding`, 404);
  if (inv.matured) return bad(`invoice ${id} has matured and can no longer be sold`, 409);

  const signed = await verifyTypedData({
    address: inv.holder,
    domain: bidDomain(CLAIM_ADDRESS),
    types: LISTING_TYPES,
    primaryType: "Listing",
    message: { id, sector: b.sector, ratingBand, teaserRef, ensName },
    signature: b.signature,
  }).catch(() => false);
  if (!signed) return bad("listing must be signed by the claim's current holder", 403);

  // Checked last, because it is the one network read that costs the most.
  try {
    if (await openListingFor(id)) return bad(`invoice ${id} already has a live listing`, 409);
  } catch {
    /* index unreachable: the write below will say so */
  }

  // One funded Tiramisu key is enough for the whole app.
  const pk = cleanKey(process.env.ARKIV_ISSUER_PK) || cleanKey(process.env.ARKIV_FIN1_PK);
  if (!pk) {
    return NextResponse.json(
      { error: "No Arkiv signing key configured. Set ARKIV_ISSUER_PK or ARKIV_FIN1_PK." },
      { status: 500 },
    );
  }

  // Signed proves the holder CHOSE the name, not that they own it. Checked
  // here and recorded, never used to refuse: see src/ens/verify.ts.
  const ensVerified = await ensNameIsOwnedBy(ensName, inv.holder);

  try {
    const { entityKey, txHash } = await publishListing(pk, {
      invoiceId: id,
      issuer: inv.issuer,
      holder: inv.holder,
      debtor: inv.debtor,
      sector: b.sector,
      faceValue: inv.faceValueHuman,
      dueDate: BigInt(inv.dueDate),
      ratingBand,
      teaserRef,
      docCommit: inv.docHash,
      claimContract: CLAIM_ADDRESS,
      ensName,
      ensVerified,
      sold: false,
    });
    return NextResponse.json({ entityKey, txHash, ensVerified });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
