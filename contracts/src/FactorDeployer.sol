// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FUSD} from "./FUSD.sol";
import {InvoiceClaim} from "./InvoiceClaim.sol";

/**
 * One-transaction deployment, for wallets that cannot export a private key.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `script/Deploy.s.sol` is the normal path and it is better: it logs, it can be
 * re-run, and it keeps deployment in version control. But it is a Foundry
 * script, so it signs with a raw private key from the environment.
 *
 * A passkey or MPC wallet has no exportable key. The account is still an
 * ordinary EOA on chain — it can sign anything the wallet chooses to sign — but
 * nothing can be pasted into `PRIVATE_KEY`. That rules out `forge script`
 * without ruling out deployment: a wallet can deploy a contract, and a contract
 * can do everything the script does.
 *
 * So this contract IS the deploy script, executed by its own constructor.
 * Deploy it once from a browser wallet (Remix → Injected Provider → Fuji) and
 * the whole setup completes in that single transaction:
 *
 *   1. deploy FUSD
 *   2. deploy InvoiceClaim against it
 *   3. mark issuer, debtor and both financiers eligible
 *   4. mint FUSD: the debtor enough to settle, each financier enough to buy
 *   5. hand ownership of the claim to whoever sent the transaction
 *
 * Read `fusd` and `claim` off this contract afterwards for the two addresses.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It does not grant the financiers' FUSD allowances, because it cannot:
 * `approve` must be sent by the token holder itself. That step belongs to each
 * financier's own wallet, and the market page has a button for it — which is
 * the same reasoning as everything above, applied one layer up.
 */
contract FactorDeployer {
    FUSD public immutable fusd;
    InvoiceClaim public immutable claim;

    /// Mirrors script/Deploy.s.sol so both paths produce the same world.
    uint256 public constant DEBTOR_FUSD = 500_000e6;
    uint256 public constant FINANCIER_FUSD = 250_000e6;

    event Deployed(address fusd, address claim, address owner);

    /**
     * @param issuer  the account that will call `issue()` — usually you
     * @param debtor  the account that will settle; funded to be able to
     * @param fin1    financier one. MUST differ from the issuer: `sell()`
     *                reverts with SelfPurchase when buyer == holder, and the
     *                issuer is the holder immediately after issuance.
     * @param fin2    financier two. MUST differ from fin1, so the demo can
     *                show a second quote undercutting the first.
     */
    constructor(address issuer, address debtor, address fin1, address fin2) {
        require(issuer != address(0) && debtor != address(0), "zero issuer/debtor");
        require(fin1 != address(0) && fin2 != address(0), "zero financier");
        require(fin1 != issuer && fin2 != issuer, "financier == issuer: sell() would revert");
        require(fin1 != fin2, "financiers must differ");

        FUSD _fusd = new FUSD();
        InvoiceClaim _claim = new InvoiceClaim(IERC20(address(_fusd)));

        address[] memory allowed = new address[](4);
        allowed[0] = issuer;
        allowed[1] = debtor;
        allowed[2] = fin1;
        allowed[3] = fin2;
        _claim.setEligibleBatch(allowed, true);

        _fusd.mint(debtor, DEBTOR_FUSD);
        _fusd.mint(fin1, FINANCIER_FUSD);
        _fusd.mint(fin2, FINANCIER_FUSD);

        // Without this the claim would stay owned by a contract nobody controls,
        // and eligibility could never be changed again.
        _claim.transferOwnership(msg.sender);

        fusd = _fusd;
        claim = _claim;
        emit Deployed(address(_fusd), address(_claim), msg.sender);
    }
}
