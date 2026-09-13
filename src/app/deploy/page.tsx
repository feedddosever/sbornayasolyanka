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
  discoverWallets,
  prepareDeploy,
  prepareEligibility,
  prepareFunding,
  resolveDeploy,
  sendPrepared,
  sendPreparedCall,
  waitForTx,
  type DeployResult,
  type PreparedDeploy,
  type WalletInfo,
} from "@/fuji/deploy";
import { explorerAddr, explorerTx } from "@/fuji/claim";

/** Pre-filled with the accounts this deployment is for. Editable, because the
 *  next person to read this repo will have different ones. */
/**
 * Already deployed, and recorded in the README. Editable because the point of
 * the section below is to fix a mismatch, and a hardcoded address is the kind
 * of thing that goes stale.
 */
const DEPLOYED = {
  claim: "0x6eCeaF4c89cFE03093Ebc55c2B750386c88c7cC0",
  fusd: "0xe21305727CE87e3Aa84D187080F8A828dB1b480E",
};

/** The accounts the operator can actually sign with. */
const SIGNABLE = [
  { address: "0xDAA819098f20d20ac3FE57B8303DBF05Cc98C429", role: "issuer + debtor", fusd: 500_000 },
  { address: "0x2A058020fa86281b6695Fad49c302182ec8aeA34", role: "financier 1", fusd: 250_000 },
  { address: "0xB6ce5887278D2271cE151aa544Cf4E46EAa84405", role: "financier 2", fusd: 250_000 },
];

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
  const [prepared, setPrepared] = useState<PreparedDeploy | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);

  // Post-deploy repair: whitelist and fund the accounts that can sign.
  const [claim, setClaim] = useState(DEPLOYED.claim);
  const [fusdAddr, setFusdAddr] = useState(DEPLOYED.fusd);
  const [signable, setSignable] = useState(SIGNABLE.map((s) => s.address).join("\n"));
  const [elig, setElig] = useState<any>(null);
  const [fund, setFund] = useState<any>(null);
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Report the environment before anything is clicked, so a missing wallet is
  // visible rather than discovered mid-transaction.
  useEffect(() => {
    setHasEthereum(typeof window !== "undefined" && !!(window as any).ethereum);
    discoverWallets().then(setWallets);
  }, []);

  /**
   * STEP ONE: everything slow. Connect, switch chain, build the calldata and
   * price it. Doing this now is what makes step two safe — see below.
   */
  async function connectAndPrepare() {
    setErr(null);
    setBusy(true);
    setResult(null);
    try {
      const acct = await connectForDeploy();
      setAccount(acct);
      setPrepared(
        await prepareDeploy({
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

  /**
   * STEP TWO: the signature request, and NOTHING may be awaited before it.
   *
   * A wallet that signs in a popup can only open that window while the browser
   * still counts a user gesture as active, and every `await` ends the gesture.
   * An earlier version of this handler connected and estimated gas first; the
   * browser blocked the popup and reported "failed to open new window", so the
   * wallet never saw the transaction at all.
   *
   * Hence `sendPrepared` on the first line. The awaits come after the wallet
   * already has the request, where they cost nothing.
   */
  function deploy() {
    if (!prepared) return;
    setErr(null);
    const sending = sendPrepared(prepared);
    setWaiting(true);
    sending
      .then((txHash) => resolveDeploy(txHash))
      .then(setResult)
      .catch((e: any) => setErr(e.shortMessage || e.message))
      .finally(() => setWaiting(false));
  }

  const signableList = signable
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as `0x${string}`[];

  /** Slow work up front, exactly as with the deployment. */
  async function prepareSetup() {
    setErr(null);
    setSetupMsg(null);
    setBusy(true);
    try {
      const acct = account ?? (await connectForDeploy());
      setAccount(acct);
      setElig(
        await prepareEligibility({
          account: acct,
          claim: claim as `0x${string}`,
          addresses: signableList,
        }),
      );
      setFund(
        await prepareFunding({
          account: acct,
          fusd: fusdAddr as `0x${string}`,
          targets: signableList.map((a, i) => ({
            address: a,
            amountHuman: SIGNABLE[i]?.fusd ?? 250_000,
          })),
        }),
      );
    } catch (e: any) {
      setErr(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  }

  /** One signature each. Nothing awaited before the request — see deploy(). */
  function grantEligibility() {
    if (!elig) return;
    setErr(null);
    const sending = sendPreparedCall(elig);
    setWaiting(true);
    sending
      .then(waitForTx)
      .then((r) => setSetupMsg(`Eligibility granted. tx ${r.hash.slice(0, 20)}…`))
      .catch((e: any) => setErr(e.shortMessage || e.message))
      .finally(() => setWaiting(false));
  }

  function mintFusd() {
    if (!fund) return;
    setErr(null);
    const sending = sendPrepared(fund);
    setWaiting(true);
    sending
      .then(waitForTx)
      .then((r) => setSetupMsg(`FUSD minted. tx ${r.hash.slice(0, 20)}…`))
      .catch((e: any) => setErr(e.shortMessage || e.message))
      .finally(() => setWaiting(false));
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
        <button className={prepared ? "ghost" : ""} onClick={connectAndPrepare} disabled={busy || waiting}>
          {busy ? "connecting…" : prepared ? "1 · re-prepare" : "1 · Connect and prepare"}
        </button>
        <button onClick={deploy} disabled={!prepared || waiting}>
          {waiting ? "waiting on the chain…" : "2 · Deploy both contracts"}
        </button>
        {account && (
          <span className="mono">
            {account.slice(0, 10)}…{" "}
            <a className="link" href={explorerAddr(account)} target="_blank" rel="noopener noreferrer">
              explorer
            </a>
          </span>
        )}
      </div>

      {prepared && !result && (
        <p className="note">
          Priced at {prepared.gasDecimal.toLocaleString()} gas and ready. Step two sends
          it with nothing awaited first, so a wallet that signs in a popup window is
          still allowed to open one — every <span className="mono">await</span> in a
          click handler ends the browser&apos;s user-gesture window and gets the popup
          blocked.
        </p>
      )}

      {!prepared && !busy && (
        <p className="note">
          Two steps on purpose. The first does all the slow work; the second is a single
          request, so the wallet can open its window.
        </p>
      )}

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

      <h2>Set up the accounts you can actually sign with</h2>
      <p className="note">
        The deployment whitelisted and funded the addresses it was given. If those are
        not the addresses in your wallet, nothing needs redeploying: you own the claim,
        so you can grant eligibility, and <span className="mono">FUSD.mint</span> has no
        access control at all. Two transactions, one signature each.
      </p>

      <div className="filters">
        <label>
          InvoiceClaim
          <input value={claim} onChange={(e) => setClaim(e.target.value)} />
        </label>
        <label>
          FUSD
          <input value={fusdAddr} onChange={(e) => setFusdAddr(e.target.value)} />
        </label>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <span className="k">accounts to whitelist and fund</span>
        <textarea
          value={signable}
          onChange={(e) => setSignable(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            marginTop: 8,
            background: "var(--panel2)",
            border: "1px solid var(--line)",
            color: "var(--ink)",
            borderRadius: 8,
            padding: "8px 10px",
            fontFamily: "var(--mono)",
            fontSize: 12,
          }}
        />
        <p className="note">
          One per line. {signableList.length} valid address
          {signableList.length === 1 ? "" : "es"} detected. FUSD amounts follow the roles:
          500,000 to the first (issuer and debtor, enough to settle), 250,000 to each of
          the other two (enough to buy).
        </p>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="ghost" onClick={prepareSetup} disabled={busy || waiting}>
          {busy ? "preparing…" : elig ? "1 · re-prepare" : "1 · Prepare both"}
        </button>
        <button onClick={grantEligibility} disabled={!elig || waiting}>
          2a · Grant eligibility
        </button>
        <button onClick={mintFusd} disabled={!fund || waiting}>
          2b · Mint FUSD
        </button>
      </div>

      {elig && fund && (
        <p className="note">
          Priced: {elig.gasDecimal.toLocaleString()} gas for eligibility,{" "}
          {fund.gasDecimal.toLocaleString()} for the mint. Eligibility is owner-only, so
          if it refused, connect the account that deployed.
        </p>
      )}

      {setupMsg && <div className="ok">{setupMsg}</div>}
    </main>
  );
}
