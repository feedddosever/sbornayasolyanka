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
} from "viem";

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
  "function sell(uint256 id, address buyer, uint256 price, bytes32 arkivBidKey)",
  "function settle(uint256 id)",
  "function setEligible(address who, bool allowed)",
  "function eligible(address) view returns (bool)",
  "function invoices(uint256) view returns (address debtor, address issuer, uint256 faceValue, uint64 dueDate, bytes32 docHash, bool settled)",
  "function ownerOf(uint256) view returns (address)",
  "function isOutstanding(uint256) view returns (bool)",
  "function nextId() view returns (uint256)",
  "event Issued(uint256 indexed id, address indexed issuer, address indexed debtor, uint256 faceValue, uint64 dueDate, bytes32 docHash)",
  "event Sold(uint256 indexed id, address indexed from, address indexed to, uint256 price, bytes32 arkivBidKey)",
  "event Settled(uint256 indexed id, address indexed paidTo, uint256 amount)",
  "event EligibilitySet(address indexed who, bool allowed)",
  "error NotEligible(address who)",
  "error PastMaturity(uint256 id)",
  "error AlreadySettled(uint256 id)",
  "error NotDebtor(address caller)",
  "error NotHolder(address caller)",
]);

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
 * Accept a bid. `arkivBidKey` is the Arkiv entity key of the offer being
 * filled, recorded on-chain so a judge (or an auditor) can reconcile the trade
 * against the expiring off-chain bid that produced it. This is the seam between
 * the two systems, made verifiable.
 */
export async function acceptBid(args: {
  account: `0x${string}`;
  id: bigint;
  buyer: `0x${string}`;
  priceHuman: string;
  arkivBidKey: `0x${string}`;
}) {
  const wallet = fujiWallet();
  return wallet.writeContract({
    account: args.account,
    address: CLAIM_ADDRESS,
    abi: claimAbi,
    functionName: "sell",
    args: [args.id, args.buyer, toFusd(args.priceHuman), args.arkivBidKey],
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
