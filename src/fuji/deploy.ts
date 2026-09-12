/**
 * Deploy Factor's contracts from the browser, with whatever wallet is there.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * There were two documented ways to get these contracts onto Fuji and both
 * assume something an operator may not have:
 *
 *   `forge script`  needs an exportable private key. A passkey or MPC wallet
 *                   signs happily and never hands the key over, so there is
 *                   nothing to put in the environment.
 *   Remix           needs to negotiate a connection with a wallet extension,
 *                   which is a separate piece of machinery with its own
 *                   failure modes and an error message ("make sure the
 *                   injected provider is unlocked") that names a symptom
 *                   rather than a cause.
 *
 * Meanwhile this app already talks to the wallet: `connectWallet` and
 * `ensureFuji` are what issue, accept and settle use. A contract deployment is
 * just a transaction with no `to` and bytecode as data, so if the wallet works
 * for the demo it works for this — and if it does not work here, the demo was
 * never going to run either.
 *
 * That makes the deploy page a diagnostic as much as a tool. The error comes
 * from code in this repository, which can say something useful.
 *
 * ── WHY IT CANNOT REUSE connectWallet() ──────────────────────────────────
 *
 * `connectWallet` calls `requireAddresses()`, which throws when
 * NEXT_PUBLIC_CLAIM_ADDRESS is unset — and it is unset, because the whole point
 * of this file is to produce it. So the connect step is duplicated here
 * deliberately, minus that check. Everything else is shared.
 */
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { fuji, ensureFuji } from "./claim";
import { FACTOR_DEPLOYER_ABI, FACTOR_DEPLOYER_BYTECODE } from "./deployerArtifact";

export interface WalletInfo {
  name: string;
  rdns?: string;
}

/**
 * What wallets does this browser actually announce?
 *
 * EIP-6963 replaced "everyone fights over window.ethereum" with an event-based
 * announcement, and it is the only reliable way to tell "no wallet installed"
 * apart from "three wallets installed and the wrong one won". Both look
 * identical from `window.ethereum`, and telling them apart is most of the
 * debugging.
 */
export function discoverWallets(timeoutMs = 600): Promise<WalletInfo[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  return new Promise((resolve) => {
    const found: WalletInfo[] = [];
    const onAnnounce = (e: any) => {
      const info = e?.detail?.info;
      if (info?.name && !found.some((f) => f.rdns === info.rdns)) {
        found.push({ name: info.name, rdns: info.rdns });
      }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(found);
    }, timeoutMs);
  });
}

/** Connect and switch to Fuji, WITHOUT requiring the addresses we are about to create. */
export async function connectForDeploy(): Promise<`0x${string}`> {
  const eth = (window as any).ethereum;
  if (!eth) {
    const wallets = await discoverWallets();
    throw new Error(
      wallets.length
        ? `A wallet is installed (${wallets
            .map((w) => w.name)
            .join(", ")}) but it does not expose window.ethereum. Open it, unlock ` +
            `it, and allow this site in its connected-sites list, then reload.`
        : `No wallet found in this browser. The Arkiv and Swarm halves of the demo ` +
            `work without one; only the Fuji leg needs to sign. Install Core ` +
            `(core.app) — it is Avalanche's own wallet and already knows Fuji.`,
    );
  }
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  if (!account) throw new Error("The wallet returned no account. Unlock it and try again.");
  await ensureFuji();
  return account;
}

export interface DeployResult {
  deployer: `0x${string}`;
  fusd: `0x${string}`;
  claim: `0x${string}`;
  txHash: `0x${string}`;
  gasUsed: string;
}

export interface PreparedDeploy {
  from: `0x${string}`;
  data: `0x${string}`;
  gas: `0x${string}`;
  gasDecimal: number;
}

/** ABI-encode one static address argument: 32 bytes, left-padded. */
const encodeAddress = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/**
 * Build and price the deployment BEFORE the user clicks.
 *
 * ── WHY PREPARATION IS SEPARATE FROM SENDING ─────────────────────────────
 *
 * A wallet that signs in a popup window can only open that window while the
 * browser still considers a user gesture active. Every `await` in a click
 * handler ends the gesture, so a handler that connects, estimates gas and then
 * asks to sign gets its popup blocked — the browser reports "failed to open new
 * window" and the transaction never reaches the wallet.
 *
 * The first version of this page did exactly that, and it is a real bug rather
 * than a browser quirk to complain about: the fix is to do the slow work early.
 * Everything that needs the network happens here, on connect. `sendPrepared`
 * then issues a single request as the very first statement after the click,
 * with nothing awaited in front of it.
 *
 * Estimating here has a second benefit: a constructor that would revert fails
 * now, with a readable reason, instead of after a wallet confirmation.
 */
export async function prepareDeploy(args: {
  account: `0x${string}`;
  issuer: `0x${string}`;
  debtor: `0x${string}`;
  fin1: `0x${string}`;
  fin2: `0x${string}`;
}): Promise<PreparedDeploy> {
  const data = (FACTOR_DEPLOYER_BYTECODE +
    encodeAddress(args.issuer) +
    encodeAddress(args.debtor) +
    encodeAddress(args.fin1) +
    encodeAddress(args.fin2)) as `0x${string}`;

  const pub = createPublicClient({ chain: fuji, transport: http() });

  let gas: bigint;
  try {
    gas = await pub.estimateGas({ account: args.account, data });
  } catch (e: any) {
    const reason = e?.shortMessage || e?.message || String(e);
    throw new Error(
      `The deployment would fail, so it was not sent. ${reason}\n\n` +
        `The usual cause is a constructor guard: both financiers must differ ` +
        `from the issuer and from each other. The other is an empty balance — ` +
        `this account needs Fuji AVAX from core.app/tools/testnet-faucet.`,
    );
  }

  // 25% headroom. An under-estimate here surfaces as an out-of-gas revert after
  // the user has already approved, which is the worst place to discover it.
  const withHeadroom = (gas * 125n) / 100n;
  return {
    from: args.account,
    data,
    gas: `0x${withHeadroom.toString(16)}`,
    gasDecimal: Number(withHeadroom),
  };
}

/**
 * Send the prepared deployment. MUST be the first thing a click handler does —
 * see the note on `prepareDeploy`. No awaits before the request, or the wallet
 * popup is blocked.
 */
export function sendPrepared(p: PreparedDeploy): Promise<`0x${string}`> {
  const eth = (window as any).ethereum;
  if (!eth) return Promise.reject(new Error("No wallet found."));
  return eth.request({
    method: "eth_sendTransaction",
    params: [{ from: p.from, data: p.data, gas: p.gas }],
  }) as Promise<`0x${string}`>;
}

/** Resolve a sent deployment into its addresses. Safe to await — the wallet is done. */
export async function resolveDeploy(txHash: `0x${string}`): Promise<DeployResult> {
  const pub = createPublicClient({ chain: fuji, transport: http() });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(
      `The deployment was mined but reverted (${txHash}). The most likely cause ` +
        `is a constructor guard: the financiers must differ from the issuer and ` +
        `from each other.`,
    );
  }
  const deployer = receipt.contractAddress;
  const [fusd, claim] = (await Promise.all([
    pub.readContract({ address: deployer, abi: FACTOR_DEPLOYER_ABI, functionName: "fusd" }),
    pub.readContract({ address: deployer, abi: FACTOR_DEPLOYER_ABI, functionName: "claim" }),
  ])) as [`0x${string}`, `0x${string}`];
  return { deployer, fusd, claim, txHash, gasUsed: receipt.gasUsed.toString() };
}

/**
 * One transaction. FactorDeployer's constructor deploys FUSD and InvoiceClaim,
 * marks all four parties eligible, mints the test stablecoin and hands
 * ownership of the claim to the account that sent it.
 *
 * The constructor reverts with a readable message if a financier equals the
 * issuer, because that is the mistake that makes `sell()` fail with
 * SelfPurchase at the exact moment a demo is meant to land.
 */
export async function deployFactor(args: {
  account: `0x${string}`;
  issuer: `0x${string}`;
  debtor: `0x${string}`;
  fin1: `0x${string}`;
  fin2: `0x${string}`;
}): Promise<DeployResult> {
  const wallet = createWalletClient({
    chain: fuji,
    transport: custom((window as any).ethereum),
  });
  const pub = createPublicClient({ chain: fuji, transport: http() });

  const txHash = await wallet.deployContract({
    abi: FACTOR_DEPLOYER_ABI,
    bytecode: FACTOR_DEPLOYER_BYTECODE,
    account: args.account,
    args: [args.issuer, args.debtor, args.fin1, args.fin2],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(
      `The deployment transaction was mined but reverted (${txHash}). The most ` +
        `likely cause is a constructor guard: the financiers must differ from ` +
        `the issuer and from each other.`,
    );
  }

  const deployer = receipt.contractAddress;
  const [fusd, claim] = (await Promise.all([
    pub.readContract({ address: deployer, abi: FACTOR_DEPLOYER_ABI, functionName: "fusd" }),
    pub.readContract({ address: deployer, abi: FACTOR_DEPLOYER_ABI, functionName: "claim" }),
  ])) as [`0x${string}`, `0x${string}`];

  return { deployer, fusd, claim, txHash, gasUsed: receipt.gasUsed.toString() };
}
