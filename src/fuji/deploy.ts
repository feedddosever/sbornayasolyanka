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
