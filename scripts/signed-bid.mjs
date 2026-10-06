/**
 * Build a SIGNED bid body for POST /api/arkiv/bids, for the evidence scripts.
 *
 * The bids endpoint only pays to index a quote the contract could fill: signed
 * (EIP-712) by an eligible financier, on an outstanding, unmatured claim, at
 * or below face value. So a witness that writes through the deployed API has
 * to bring all of that, the same as the market page does. This is that step,
 * shared by evidence-rpc.py and evidence-ws.mjs.
 *
 * Env:
 *   EVIDENCE_FIN_PK            Fuji private key of an ELIGIBLE financier (not the holder)
 *   EVIDENCE_INVOICE_ID        an outstanding, unmatured invoice on the claim contract
 *   NEXT_PUBLIC_CLAIM_ADDRESS  the InvoiceClaim the API is configured with
 *   NEXT_PUBLIC_FUJI_RPC       optional Fuji RPC override
 *
 * Usage: node scripts/signed-bid.mjs [ttlSeconds] [discountBps] [ensName]
 *   prints the JSON body on stdout; diagnostics go to stderr.
 */
import { createPublicClient, http, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FUJI_RPC = process.env.NEXT_PUBLIC_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
const abi = parseAbi([
  "function invoices(uint256) view returns (address debtor, address issuer, uint256 faceValue, uint64 dueDate, bytes32 docHash, bool settled)",
]);

export async function signedBidBody({ ttlSeconds = 40, discountBps = 450, ensName = "evidence.factor.eth" } = {}) {
  const pk = process.env.EVIDENCE_FIN_PK?.trim();
  const claim = (process.env.NEXT_PUBLIC_CLAIM_ADDRESS || process.env.CLAIM_ADDRESS)?.trim();
  const id = BigInt(process.env.EVIDENCE_INVOICE_ID ?? "0");
  const missing = [
    !pk && "EVIDENCE_FIN_PK",
    !claim && "NEXT_PUBLIC_CLAIM_ADDRESS",
    !id && "EVIDENCE_INVOICE_ID",
  ].filter(Boolean);
  if (missing.length) throw new Error(`set ${missing.join(", ")} (see the header of scripts/signed-bid.mjs)`);

  const fin = privateKeyToAccount(pk);
  const fuji = createPublicClient({ transport: http(FUJI_RPC) });
  const [, , face, , , settled] = await fuji.readContract({ address: claim, abi, functionName: "invoices", args: [id] });
  if (face === 0n || settled) throw new Error(`invoice ${id} is not outstanding on ${claim}`);

  const bid = {
    id,
    buyer: fin.address,
    price: (face * BigInt(10_000 - discountBps)) / 10_000n,
    // A little headroom: the server derives the entity's lifetime from this.
    deadline: BigInt(Math.floor(Date.now() / 1000) + ttlSeconds + 2),
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await fin.signTypedData({
    domain: { name: "Factor Invoice Claim", version: "1", chainId: 43113, verifyingContract: claim },
    types: {
      Bid: [
        { name: "id", type: "uint256" },
        { name: "buyer", type: "address" },
        { name: "price", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "salt", type: "bytes32" },
      ],
    },
    primaryType: "Bid",
    message: bid,
  });

  return {
    invoiceId: id.toString(),
    financierSlot: 1,
    sector: "logistics",
    ensName,
    signed: {
      bid: {
        id: id.toString(),
        buyer: bid.buyer,
        price: bid.price.toString(),
        deadline: bid.deadline.toString(),
        salt: bid.salt,
      },
      signature,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ttl, bps, ens] = process.argv.slice(2);
  signedBidBody({
    ttlSeconds: ttl ? Number(ttl) : undefined,
    discountBps: bps ? Number(bps) : undefined,
    ensName: ens,
  })
    .then((b) => process.stdout.write(JSON.stringify(b)))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
