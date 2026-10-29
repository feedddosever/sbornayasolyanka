/**
 * Avalanche Fuji C-Chain: the money layer.
 *
 * This is the only layer that can hold value and REVERT a transfer that breaks
 * a rule, which is why the asset lives here and the bid book does not.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  defineChain,
  formatUnits,
  parseUnits,
  toHex,
} from "viem";
import type { SignedBidWire } from "@/arkiv/schema";

export const fuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
  blockExplorers: {
    default: { name: "Snowtrace", url: "https://testnet.snowtrace.io" },
  },
  testnet: true,
});

export const FUSD_DECIMALS = 6;
export const toFusd = (human: string) => parseUnits(human, FUSD_DECIMALS);
export const fromFusd = (raw: bigint) => formatUnits(raw, FUSD_DECIMALS);

export const claimAbi = parseAbi([
  "function issue(address debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash) returns (uint256)",
  "struct Bid { uint256 claimId; address buyer; uint256 price; uint64 deadline; bytes32 nonce; }",
  "function sell(Bid bid, bytes signature, bytes32 arkivBidKey)",
  "function hashBid(Bid bid) view returns (bytes32)",
  "function bidUsed(address buyer, bytes32 nonce) view returns (bool)",
  "function settle(uint256 id)",
  "function setEligible(address who, bool allowed)",
  "function eligible(address) view returns (bool)",
  "function invoices(uint256) view returns (address debtor, address issuer, uint256 faceValue, uint64 dueDate, bytes32 docHash, bool settled)",
  "function ownerOf(uint256) view returns (address)",
  "function isOutstanding(uint256) view returns (bool)",
  "function nextId() view returns (uint256)",
  "event Issued(uint256 indexed id, address indexed issuer, address indexed debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash)",
  "event Sold(uint256 indexed id, address indexed from, address indexed to, uint256 price, bytes32 arkivBidKey, bytes32 bidNonce)",
  "event Settled(uint256 indexed id, address indexed paidTo, uint256 amount)",
  "event EligibilitySet(address indexed who, bool allowed)",
  "error NotEligible(address who)",
  "error PastMaturity(uint256 id)",
  "error AlreadySettled(uint256 id)",
  "error NotDebtor(address caller)",
  "error NotHolder(address caller)",
  "error SelfPurchase()",
  "error BadBidSignature()",
  "error BidExpired(uint64 deadline)",
  "error BidAlreadyUsed(bytes32 nonce)",
]);

/**
 * The EIP-712 type a financier signs. MUST match `BID_TYPEHASH` in
 * InvoiceClaim.sol field for field - `test_HashBid_MatchesEip712Layout` pins
 * the Solidity side.
 */
export const BID_TYPES = {
  Bid: [
    { name: "claimId", type: "uint256" },
    { name: "buyer", type: "address" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const bidDomain = () =>
  ({
    name: "Factor Invoice Claim",
    version: "1",
    chainId: fuji.id,
    verifyingContract: CLAIM_ADDRESS,
  }) as const;

export interface Bid {
  claimId: bigint;
  buyer: `0x${string}`;
  price: bigint;
  deadline: bigint;
  nonce: `0x${string}`;
}

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

export const CLAIM_ADDRESS = process.env.NEXT_PUBLIC_CLAIM_ADDRESS as `0x${string}`;
export const FUSD_ADDRESS = process.env.NEXT_PUBLIC_FUSD_ADDRESS as `0x${string}`;

/** Fail loudly and usefully instead of letting viem throw something cryptic
 *  about an undefined address twenty frames deep. */
export function requireAddresses() {
  const missing: string[] = [];
  if (!CLAIM_ADDRESS) missing.push("NEXT_PUBLIC_CLAIM_ADDRESS");
  if (!FUSD_ADDRESS) missing.push("NEXT_PUBLIC_FUSD_ADDRESS");
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(" and ")} in .env.local. Run ` +
        `\`npm run contracts:deploy\` and paste the printed addresses.`,
    );
  }
}

export const fujiPublic = createPublicClient({ chain: fuji, transport: http() });

/** Browser wallet, for the one layer where a real signature belongs.
 *  Arkiv writes use an in-app signer and ENS setup is a pre-run script, so the
 *  user is never asked to switch networks mid-demo. */
export function fujiWallet() {
  if (typeof window === "undefined" || !(window as any).ethereum) {
    throw new Error("No injected wallet found. Install MetaMask or Core.");
  }
  return createWalletClient({ chain: fuji, transport: custom((window as any).ethereum) });
}

const FUJI_HEX = "0xa869"; // 43113

/**
 * Make sure the wallet is actually on Fuji before a write.
 *
 * Without this, a wallet sitting on mainnet signs against the wrong chain and
 * the failure surfaces as an unrelated revert — the worst possible thing to
 * debug in front of judges.
 */
export async function ensureFuji(): Promise<void> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No injected wallet found.");

  const current = await eth.request({ method: "eth_chainId" });
  if (current === FUJI_HEX) return;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: FUJI_HEX }],
    });
  } catch (e: any) {
    // 4902 = chain unknown to the wallet; offer to add it.
    if (e?.code === 4902 || /Unrecognized chain/i.test(String(e?.message))) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: FUJI_HEX,
            chainName: "Avalanche Fuji C-Chain",
            nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
            rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
            blockExplorerUrls: ["https://testnet.snowtrace.io"],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

/** Connect, and guarantee we are on Fuji. Use this everywhere instead of
 *  calling eth_requestAccounts inline. */
export async function connectWallet(): Promise<`0x${string}`> {
  requireAddresses();
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No injected wallet found. Install MetaMask or Core.");
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  await ensureFuji();
  return account;
}

export interface OnChainInvoice {
  id: bigint;
  debtor: `0x${string}`;
  issuer: `0x${string}`;
  faceValue: bigint;
  faceValueHuman: string;
  dueDate: number;
  docHash: `0x${string}`;
  settled: boolean;
  holder: `0x${string}` | null;
  matured: boolean;
}

export async function readInvoice(id: bigint): Promise<OnChainInvoice> {
  const [debtor, issuer, faceValue, dueDate, docHash, settled] =
    await fujiPublic.readContract({
      address: CLAIM_ADDRESS,
      abi: claimAbi,
      functionName: "invoices",
      args: [id],
    });

  const holder = await fujiPublic
    .readContract({ address: CLAIM_ADDRESS, abi: claimAbi, functionName: "ownerOf", args: [id] })
    .catch(() => null);

  return {
    id,
    debtor,
    issuer,
    faceValue,
    faceValueHuman: fromFusd(faceValue),
    dueDate: Number(dueDate),
    docHash,
    settled,
    holder: holder as `0x${string}` | null,
    matured: Number(dueDate) * 1000 <= Date.now(),
  };
}

export async function isEligible(who: `0x${string}`) {
  return fujiPublic.readContract({
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "eligible",
    args: [who],
  });
}

/**
 * Issue an invoice and return the minted token id.
 *
 * The id is read from the `Issued` event in the receipt. It is NOT the return
 * value of the transaction — a state-changing call gives you a hash, not the
 * function's return, so the event is the only way to learn the id. (An earlier
 * version of this app asked the user to type it in, which is exactly the kind
 * of thing that makes a demo look broken.)
 */
export async function issueInvoice(args: {
  account: `0x${string}`;
  debtor: `0x${string}`;
  faceValueHuman: string;
  dueDate: Date;
  docHash: `0x${string}`;
}): Promise<{ hash: `0x${string}`; invoiceId: bigint }> {
  requireAddresses();
  const wallet = fujiWallet();

  const hash = await wallet.writeContract({
    account: args.account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "issue",
    args: [
      args.debtor,
      toFusd(args.faceValueHuman),
      BigInt(Math.floor(args.dueDate.getTime() / 1000)),
      args.docHash,
    ],
  });

  const receipt = await fujiPublic.waitForTransactionReceipt({ hash });
  const [issued] = parseEventLogs({
    abi: claimAbi,
    eventName: "Issued",
    logs: receipt.logs,
  });

  if (!issued) {
    throw new Error(
      `Issued event not found in ${hash}. The transaction landed but the id ` +
        `could not be read — check you are pointed at the right contract.`,
    );
  }

  return { hash, invoiceId: (issued as any).args.id as bigint };
}

/**
 * Sign a bid as the connected financier. Off-chain and gas-free: this is the
 * financier's consent to pay `priceHuman` for this one claim, and `sell()`
 * will execute nothing else in their name.
 *
 * `ttlSeconds` becomes the on-chain deadline, matching the Arkiv lifetime, so
 * the quote stops being executable when it stops being listed. The nonce is
 * random so two otherwise identical bids are still different signatures.
 */
export async function signBid(args: {
  account: `0x${string}`;
  claimId: bigint;
  priceHuman: string;
  ttlSeconds: number;
}): Promise<SignedBidWire> {
  requireAddresses();
  const bid: Bid = {
    claimId: args.claimId,
    buyer: args.account,
    price: toFusd(args.priceHuman),
    deadline: BigInt(Math.floor(Date.now() / 1000) + args.ttlSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await fujiWallet().signTypedData({
    account: args.account,
    domain: bidDomain(),
    types: BID_TYPES,
    primaryType: "Bid",
    message: bid,
  });
  return {
    claimId: bid.claimId.toString(),
    buyer: bid.buyer,
    price: bid.price.toString(),
    deadline: bid.deadline.toString(),
    nonce: bid.nonce,
    signature,
  };
}

export const bidFromWire = (w: SignedBidWire): Bid => ({
  claimId: BigInt(w.claimId),
  buyer: w.buyer,
  price: BigInt(w.price),
  deadline: BigInt(w.deadline),
  nonce: w.nonce,
});

/**
 * Accept a bid. The terms come from the financier's signature, not from this
 * call: the holder chooses WHICH bid to fill and nothing else.
 *
 * `arkivBidKey` is the Arkiv entity key of the offer being filled, recorded
 * on-chain so a judge (or an auditor) can reconcile the trade against the
 * expiring off-chain bid that produced it. This is the seam between the two
 * systems, made verifiable.
 */
export async function acceptBid(args: {
  account: `0x${string}`;
  signed: SignedBidWire;
  arkivBidKey: `0x${string}`;
}) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account: args.account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "sell",
    args: [bidFromWire(args.signed), args.signed.signature, args.arkivBidKey],
  });
}

export async function approveFusd(account: `0x${string}`, amountHuman: string) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account,
    address: FUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CLAIM_ADDRESS, toFusd(amountHuman)],
  });
}

export async function settleInvoice(account: `0x${string}`, id: bigint) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "settle",
    args: [id],
  });
}

export const explorerTx = (hash: string) => `https://testnet.snowtrace.io/tx/${hash}`;
export const explorerAddr = (a: string) => `https://testnet.snowtrace.io/address/${a}`;

/**
 * Fit an Arkiv entity key into `bytes32` for `sell()`.
 *
 * Entity keys are 32 bytes today, so this is normally a pass-through. If a
 * future SDK returns a different width we hash instead of throwing: losing the
 * ability to accept a bid mid-demo over a key-format change would be a terrible
 * trade, and a keccak of the key is still a stable, verifiable reference to the
 * exact bid that was filled.
 */
export function toBytes32(key: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (hex.length === 64) return `0x${hex}` as `0x${string}`;
  return keccak256(key.startsWith("0x") ? (key as `0x${string}`) : `0x${hex}`);
}
