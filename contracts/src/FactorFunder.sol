// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FUSD} from "./FUSD.sol";

/**
 * Mint the test stablecoin to three accounts in ONE transaction.
 *
 * ── WHY A CONTRACT FOR THREE MINTS ────────────────────────────────────────
 *
 * `FUSD.mint` has no access control — it is a test token, and anybody may mint.
 * So three mints are three ordinary transactions, and that is the problem: a
 * wallet that signs in a popup window may only open it while the browser still
 * counts a user gesture as active. Three sequential signatures from one click
 * means two blocked popups, which is the failure that cost this project an hour
 * earlier tonight.
 *
 * One deployment is one signature. The constructor does the work and the
 * contract is never needed again.
 *
 * Parameters are static types on purpose: an `address[]` would need dynamic ABI
 * encoding in the browser, and the deploy page builds its calldata by hand so
 * that nothing has to be awaited before the wallet is asked to sign.
 */
contract FactorFunder {
    event Funded(address token, address a, address b, address c);

    constructor(
        FUSD fusd,
        address a,
        uint256 amountA,
        address b,
        uint256 amountB,
        address c,
        uint256 amountC
    ) {
        require(address(fusd) != address(0), "zero token");
        if (a != address(0) && amountA > 0) fusd.mint(a, amountA);
        if (b != address(0) && amountB > 0) fusd.mint(b, amountB);
        if (c != address(0) && amountC > 0) fusd.mint(c, amountC);
        emit Funded(address(fusd), a, b, c);
    }
}
