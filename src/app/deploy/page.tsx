"use client";

/**
 * A deploy page, because the two standard routes both needed something the
 * operator did not have. See src/fuji/deploy.ts for the reasoning.
 *
 * It is deliberately honest about what it cannot do: if the browser has no
 * wallet, it says which halves of the demo still work rather than implying the
 * project is broken.
 */
import { useEffect, useState } from "react";
import {
  connectForDeploy,
  deployFactor,
  discoverWallets,
  type DeployResult,
  type WalletInfo,
} from "@/fuji/deploy";
import { explorerAddr, explorerTx } from "@/fuji/claim";

/** Pre-filled with the accounts this deployment is for. Editable, because the
 *  next person to read this repo will have different ones. */
const DEFAULTS = {
  issuer: "0x509709a89f827AA8D3F4729F508518b8D44643a6",
  debtor: "0x509709a89f827AA8D3F4729F508518b8D44643a6",
  fin1: "0x23F2e037b5aD1d62454dA79515a4D661415469f4",
  fin2: "0x00CB614D71Fd3d31e9c10Bc4c3f3739CAb95e948",
};

export default function DeployPage() {
  const [issuer, setIssuer] = useState(DEFAULTS.issuer);
  const [debtor, setDebtor] = useState(DEFAULTS.debtor);
  const [fin1, setFin1] = useState(DEFAULTS.fin1);
  const [fin2, setFin2] = useState(DEFAULTS.fin2);

  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [hasEthereum, setHasEthereum] = useState<boolean | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Report the environment before anything is clicked, so a missing wallet is
  // visible rather than discovered mid-transaction.
  useEffect(() => {
    setHasEthereum(typeof window !== "undefined" && !!(window as any).ethereum);
    discoverWallets().then(setWallets);
  }, []);

  async function connect() {
    setErr(null);
    setBusy(true);
    try {
      setAccount(await connectForDeploy());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    setErr(null);
    setBusy(true);
    setResult(null);
    try {
      const acct = account ?? (await connectForDeploy());
      setAccount(acct);
      setResult(
        await deployFactor({
          account: acct,
          issuer: issuer as `0x${string}`,
          debtor: debtor as `0x${string}`,
          fin1: fin1 as `0x${string}`,
          fin2: fin2 as `0x${string}`,
        }),
      );
    } catch (e: any) {
      setErr(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  }

  const envBlock = result
    ? [
        `NEXT_PUBLIC_CLAIM_ADDRESS=${result.claim}`,
        `NEXT_PUBLIC_FUSD_ADDRESS=${result.fusd}`,
        `NEXT_PUBLIC_FIN1_ADDR=${fin1}`,
        `NEXT_PUBLIC_FIN2_ADDR=${fin2}`,
      ].join("\n")
    : "";

  return (
    <main>
      <h1>Deploy to Fuji</h1>
      <p className="sub">
        One transaction deploys both contracts, marks every party eligible, mints the
        test stablecoin and hands ownership of the claim to the account that signs.
        Signed by whatever wallet this browser has — no private key, no Foundry, no
        external IDE.
      </p>

      <h2>Environment</h2>
      <div className="card">
        <div className="row">
          <span className="k">window.ethereum</span>
          <span className="mono">
            {hasEthereum === null ? "checking…" : hasEthereum ? "present" : "absent"}
          </span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="k">wallets announced</span>
          <span className="mono">
            {wallets === null
              ? "checking…"
              : wallets.length
                ? wallets.map((w) => w.name).join(", ")
                : "none"}
          </span>
        </div>
        {wallets !== null && wallets.length > 1 && (
          <p className="note">
            More than one wallet is installed. They compete for{" "}
            <span className="mono">window.ethereum</span> and the winner may not be the
            one holding your funded account — if the deployment signs from an
            unexpected address, disable the others.
          </p>
        )}
        {hasEthereum === false && (
          <p className="note">
            The Arkiv and Swarm parts of this demo need no wallet and work as they are.
            Only this page and the on-chain buttons on the market need one.
          </p>
        )}
      </div>

      <h2>Parties</h2>
      <div className="filters">
        <label>
          Issuer — calls issue()
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </label>
        <label>
          Debtor — settles, gets 500,000 FUSD
          <input value={debtor} onChange={(e) => setDebtor(e.target.value)} />
        </label>
        <label>
          Financier 1 — gets 250,000 FUSD
          <input value={fin1} onChange={(e) => setFin1(e.target.value)} />
        </label>
        <label>
          Financier 2 — gets 250,000 FUSD
          <input value={fin2} onChange={(e) => setFin2(e.target.value)} />
        </label>
      </div>
      <p className="note">
        Both financiers must differ from the issuer and from each other. The issuer
        holds the claim immediately after issuance, and <span className="mono">sell()</span>{" "}
        reverts with <span className="mono">SelfPurchase</span> when the buyer is the
        holder — so the constructor refuses rather than letting the demo fail later.
      </p>

      <div className="row" style={{ marginTop: 18 }}>
        <button onClick={deploy} disabled={busy}>
          {busy ? "waiting on the wallet…" : "Deploy both contracts"}
        </button>
        {!account && (
          <button className="ghost" onClick={connect} disabled={busy}>
            Just connect, don&apos;t deploy
          </button>
        )}
        {account && (
          <span className="mono">
            signing as {account.slice(0, 10)}…{" "}
            <a className="link" href={explorerAddr(account)} target="_blank" rel="noopener noreferrer">
              explorer
            </a>
          </span>
        )}
      </div>

      {err && <div className="err">{err}</div>}

      {result && (
        <>
          <div className="ok">
            Deployed. Ownership of the claim now sits with {account?.slice(0, 10)}…, not
            with the deployer contract. Gas used {Number(result.gasUsed).toLocaleString()}.
          </div>

          <h2>Addresses</h2>
          <div className="card">
            <div className="row">
              <span className="k">FUSD</span>
              <span className="mono">{result.fusd}</span>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="k">InvoiceClaim</span>
              <span className="mono">{result.claim}</span>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="k">transaction</span>
              <a className="link mono" href={explorerTx(result.txHash)} target="_blank" rel="noopener noreferrer">
                {result.txHash.slice(0, 22)}…
              </a>
            </div>
          </div>

          <h2>Paste into Vercel, then redeploy</h2>
          <p className="note">
            These are <span className="mono">NEXT_PUBLIC_</span> variables, so they are
            baked in at build time — the values do not take effect until the next build.
          </p>
          <div className="query">{envBlock}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(envBlock)}>
              Copy all four
            </button>
          </div>
        </>
      )}
    </main>
  );
}
