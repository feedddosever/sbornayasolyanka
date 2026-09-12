// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FactorDeployer} from "../src/FactorDeployer.sol";
import {FUSD} from "../src/FUSD.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";

/**
 * The one-transaction deployer is going to be run from a browser wallet, blind,
 * against a real faucet balance. A failed constructor there costs gas and time
 * and gives no useful message, so the whole thing is exercised here first with
 * the addresses it will actually be given.
 */
contract FactorDeployerTest is Test {
    // The real Fuji accounts this will be deployed with.
    address constant ISSUER = 0x509709a89f827AA8D3F4729F508518b8D44643a6;
    address constant FIN1 = 0x23F2e037b5aD1d62454dA79515a4D661415469f4;
    address constant FIN2 = 0x00CB614D71Fd3d31e9c10Bc4c3f3739CAb95e948;

    address constant SENDER = address(0xBEEF);

    function test_OneTransactionSetsUpEverything() public {
        vm.prank(SENDER);
        // Issuer doubles as the debtor here, exactly as the plan intends: the
        // demo needs the two FINANCIERS to be distinct from the issuer, not the
        // debtor.
        FactorDeployer d = new FactorDeployer(ISSUER, ISSUER, FIN1, FIN2);

        FUSD fusd = d.fusd();
        InvoiceClaim claim = d.claim();

        assertTrue(address(fusd) != address(0), "fusd not deployed");
        assertTrue(address(claim) != address(0), "claim not deployed");

        // Eligibility: all four parties can hold or move a claim.
        assertTrue(claim.eligible(ISSUER), "issuer not eligible");
        assertTrue(claim.eligible(FIN1), "fin1 not eligible");
        assertTrue(claim.eligible(FIN2), "fin2 not eligible");

        // A stranger must still be refused, or the policy is decorative.
        assertFalse(claim.eligible(address(0xDEAD)), "stranger should not be eligible");

        // Balances: the debtor can settle, each financier can buy.
        assertEq(fusd.balanceOf(ISSUER), d.DEBTOR_FUSD(), "debtor balance");
        assertEq(fusd.balanceOf(FIN1), d.FINANCIER_FUSD(), "fin1 balance");
        assertEq(fusd.balanceOf(FIN2), d.FINANCIER_FUSD(), "fin2 balance");

        // Ownership must end up with the human, not with a contract nobody
        // controls — otherwise eligibility could never be changed again.
        assertEq(claim.owner(), SENDER, "ownership not handed over");
    }

    function test_TheDeployerCanStillManageEligibilityAfterwards() public {
        vm.prank(SENDER);
        FactorDeployer d = new FactorDeployer(ISSUER, ISSUER, FIN1, FIN2);
        InvoiceClaim claim = d.claim();

        vm.prank(SENDER);
        claim.setEligible(address(0xCAFE), true);
        assertTrue(claim.eligible(address(0xCAFE)), "owner cannot grant eligibility");
    }

    function test_RejectsFinancierEqualToIssuer() public {
        // This is the mistake that makes the headline "accept a bid" moment
        // revert with SelfPurchase, so it is refused at construction instead.
        vm.expectRevert("financier == issuer: sell() would revert");
        new FactorDeployer(ISSUER, ISSUER, ISSUER, FIN2);
    }

    function test_RejectsIdenticalFinanciers() public {
        vm.expectRevert("financiers must differ");
        new FactorDeployer(ISSUER, ISSUER, FIN1, FIN1);
    }

    function test_RejectsZeroAddresses() public {
        vm.expectRevert("zero issuer/debtor");
        new FactorDeployer(address(0), ISSUER, FIN1, FIN2);

        vm.expectRevert("zero financier");
        new FactorDeployer(ISSUER, ISSUER, address(0), FIN2);
    }
}
