// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FUSD} from "../src/FUSD.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";

/**
 * Deploy with one key, hand the result to somebody else.
 *
 * `Deploy.s.sol` leaves the claim owned by whoever signed, which is right when
 * the signer is the operator. It is wrong when the signer is a disposable key
 * that exists only to get the contracts on chain — then ownership has to end up
 * with a real account, or eligibility could never be changed again.
 *
 * Env:
 *   PRIVATE_KEY   the throwaway signer, funded from the faucet
 *   OWNER_ADDR    who ends up owning the claim
 *   ISSUER_ADDR   who will call issue()
 *   DEBTOR_ADDR   who will settle (funded with FUSD to be able to)
 *   FIN1_ADDR     financier one, must differ from the issuer
 *   FIN2_ADDR     financier two, must differ from fin1
 */
contract DeployFor is Script {
    uint256 constant DEBTOR_FUSD = 500_000e6;
    uint256 constant FINANCIER_FUSD = 250_000e6;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER_ADDR");
        address issuer = vm.envAddress("ISSUER_ADDR");
        address debtor = vm.envAddress("DEBTOR_ADDR");
        address fin1 = vm.envAddress("FIN1_ADDR");
        address fin2 = vm.envAddress("FIN2_ADDR");

        require(fin1 != issuer && fin2 != issuer, "financier == issuer: sell() would revert");
        require(fin1 != fin2, "financiers must differ");

        vm.startBroadcast(pk);

        FUSD fusd = new FUSD();
        InvoiceClaim claim = new InvoiceClaim(IERC20(address(fusd)));

        address[] memory allowed = new address[](4);
        allowed[0] = issuer;
        allowed[1] = debtor;
        allowed[2] = fin1;
        allowed[3] = fin2;
        claim.setEligibleBatch(allowed, true);

        fusd.mint(debtor, DEBTOR_FUSD);
        fusd.mint(fin1, FINANCIER_FUSD);
        fusd.mint(fin2, FINANCIER_FUSD);

        // The whole point of this script: the disposable key does not keep
        // control of anything.
        claim.transferOwnership(owner);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Factor deployed to Fuji (43113) ===");
        console.log("FUSD          %s", address(fusd));
        console.log("InvoiceClaim  %s", address(claim));
        console.log("claim owner   %s", claim.owner());
        console.log("");
        console.log("Vercel environment variables:");
        console.log("  NEXT_PUBLIC_FUSD_ADDRESS=%s", address(fusd));
        console.log("  NEXT_PUBLIC_CLAIM_ADDRESS=%s", address(claim));
        console.log("  NEXT_PUBLIC_FIN1_ADDR=%s", fin1);
        console.log("  NEXT_PUBLIC_FIN2_ADDR=%s", fin2);
        console.log("");
        console.log("FUSD balances: debtor %s, fin1 %s, fin2 %s",
            fusd.balanceOf(debtor), fusd.balanceOf(fin1), fusd.balanceOf(fin2));
    }
}
