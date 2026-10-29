// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FUSD} from "../src/FUSD.sol";
import {InvoiceClaim} from "../src/InvoiceClaim.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract InvoiceClaimTest is Test {
    FUSD internal fusd;
    InvoiceClaim internal claim;

    address internal platform = address(0xA11CE);
    address internal acme = address(0xACC1); // issuer (SME)
    address internal debtor = address(0xDEB7);
    // Financiers sign their bids, so they need keys, not just addresses.
    address internal financier;
    uint256 internal financierPk;
    address internal financier2;
    uint256 internal financier2Pk;
    address internal stranger = address(0xBAD);

    uint256 internal constant FACE = 10_000e6; // 10,000 FUSD
    uint64 internal dueDate;

    event Sold(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint256 price,
        bytes32 arkivBidKey,
        bytes32 bidNonce
    );
    event Settled(uint256 indexed id, address indexed paidTo, uint256 amount);

    function setUp() public {
        vm.warp(1_800_000_000); // a fixed, sane "now"
        (financier, financierPk) = makeAddrAndKey("financier");
        (financier2, financier2Pk) = makeAddrAndKey("financier2");
        dueDate = uint64(block.timestamp + 60 days);

        vm.prank(platform);
        fusd = new FUSD();
        vm.prank(platform);
        claim = new InvoiceClaim(IERC20(address(fusd)));

        address[] memory allowed = new address[](4);
        allowed[0] = acme;
        allowed[1] = financier;
        allowed[2] = financier2;
        allowed[3] = debtor;
        vm.prank(platform);
        claim.setEligibleBatch(allowed, true);

        fusd.mint(financier, 1_000_000e6);
        fusd.mint(financier2, 1_000_000e6);
        fusd.mint(debtor, 1_000_000e6);
    }

    function _issue() internal returns (uint256 id) {
        vm.prank(acme);
        id = claim.issue(debtor, FACE, dueDate, keccak256("swarm-ref"));
    }

    uint256 internal nonceSeq;

    /// A bid as the app builds it: 60s lifetime, fresh nonce.
    function _bid(uint256 id, address buyer, uint256 price)
        internal
        returns (InvoiceClaim.Bid memory)
    {
        return InvoiceClaim.Bid({
            claimId: id,
            buyer: buyer,
            price: price,
            deadline: uint64(block.timestamp + 60),
            nonce: bytes32(++nonceSeq)
        });
    }

    function _sign(InvoiceClaim.Bid memory bid, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, claim.hashBid(bid));
        return abi.encodePacked(r, s, v);
    }

    /// Approve, sign, fill: the path every legitimate sale takes.
    function _sell(
        uint256 id,
        address seller,
        address buyer,
        uint256 buyerPk,
        uint256 price,
        bytes32 arkivBidKey
    ) internal returns (InvoiceClaim.Bid memory bid) {
        vm.prank(buyer);
        fusd.approve(address(claim), price);
        bid = _bid(id, buyer, price);
        bytes memory sig = _sign(bid, buyerPk);
        vm.prank(seller);
        claim.sell(bid, sig, arkivBidKey);
    }

    // ------------------------------------------------------------- issuance

    function test_Issue_MintsToIssuerAndStoresTerms() public {
        uint256 id = _issue();

        assertEq(claim.ownerOf(id), acme, "issuer should hold the fresh claim");
        (
            address d,
            address i,
            uint256 fv,
            uint64 dd,
            bytes32 dh,
            bool settled
        ) = claim.invoices(id);
        assertEq(d, debtor);
        assertEq(i, acme);
        assertEq(fv, FACE);
        assertEq(dd, dueDate);
        assertEq(dh, keccak256("swarm-ref"));
        assertFalse(settled);
        assertTrue(claim.isOutstanding(id));
    }

    function test_Issue_IncrementsIds() public {
        uint256 a = _issue();
        uint256 b = _issue();
        assertEq(b, a + 1);
    }

    function test_RevertWhen_IssuerNotEligible() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, stranger));
        claim.issue(debtor, FACE, dueDate, bytes32(0));
    }

    function test_RevertWhen_FaceValueZero() public {
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadFaceValue.selector);
        claim.issue(debtor, 0, dueDate, bytes32(0));
    }

    function test_RevertWhen_DueDateInPast() public {
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadDueDate.selector);
        claim.issue(debtor, FACE, uint64(block.timestamp - 1), bytes32(0));
    }

    // ------------------------------------------------------- POLICY: eligibility

    function test_RevertWhen_SellingToIneligibleBuyer() public {
        uint256 id = _issue();
        (address outsider, uint256 outsiderPk) = makeAddrAndKey("outsider");
        InvoiceClaim.Bid memory bid = _bid(id, outsider, 9_700e6);
        bytes memory sig = _sign(bid, outsiderPk);
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, outsider));
        claim.sell(bid, sig, bytes32(0));
    }

    /// The policy must hold even when someone bypasses `sell` and uses the raw
    /// ERC-721 path. This is the test that proves the hook, not the wrapper.
    function test_RevertWhen_DirectTransferToIneligible() public {
        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, stranger));
        claim.transferFrom(acme, stranger, id);
    }

    function test_RevokingEligibilityBlocksFutureTransfers() public {
        uint256 id = _issue();

        vm.prank(platform);
        claim.setEligible(financier, false);

        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, financier));
        claim.transferFrom(acme, financier, id);
    }

    function test_RevertWhen_NonOwnerSetsEligibility() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        claim.setEligible(stranger, true);
    }

    // ------------------------------------------------------------ RULE: maturity

    function test_RevertWhen_TransferAtOrAfterMaturity() public {
        uint256 id = _issue();
        vm.warp(dueDate); // exactly at maturity - boundary is inclusive

        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.PastMaturity.selector, id));
        claim.transferFrom(acme, financier, id);
    }

    function test_TransferAllowedOneSecondBeforeMaturity() public {
        uint256 id = _issue();
        vm.warp(uint256(dueDate) - 1);

        vm.prank(acme);
        claim.transferFrom(acme, financier, id);
        assertEq(claim.ownerOf(id), financier);
    }

    // ------------------------------------------------------------------- sale

    function test_Sell_MovesClaimAndCash() public {
        uint256 id = _issue();
        uint256 price = 9_700e6; // 3% discount

        uint256 acmeBefore = fusd.balanceOf(acme);
        uint256 finBefore = fusd.balanceOf(financier);

        _sell(id, acme, financier, financierPk, price, keccak256("arkiv-bid-1"));

        assertEq(claim.ownerOf(id), financier, "claim should move to the financier");
        assertEq(fusd.balanceOf(acme), acmeBefore + price, "issuer receives discounted cash");
        assertEq(fusd.balanceOf(financier), finBefore - price);
    }

    function test_Sell_EmitsArkivBidKeyAndNonce() public {
        uint256 id = _issue();
        uint256 price = 9_700e6;
        bytes32 bidKey = keccak256("arkiv-bid-42");

        vm.prank(financier);
        fusd.approve(address(claim), price);
        InvoiceClaim.Bid memory bid = _bid(id, financier, price);
        bytes memory sig = _sign(bid, financierPk);

        vm.expectEmit(true, true, true, true);
        emit Sold(id, acme, financier, price, bidKey, bid.nonce);

        vm.prank(acme);
        claim.sell(bid, sig, bidKey);
        assertTrue(claim.bidUsed(financier, bid.nonce));
    }

    function test_RevertWhen_SellerIsNotHolder() public {
        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _bid(id, financier2, 1e6);
        bytes memory sig = _sign(bid, financier2Pk);
        vm.prank(financier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotHolder.selector, financier));
        claim.sell(bid, sig, bytes32(0));
    }

    function test_RevertWhen_SellingToSelf() public {
        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _bid(id, acme, 1e6);
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.SelfPurchase.selector);
        claim.sell(bid, "", bytes32(0));
    }

    function test_RevertWhen_BuyerHasNotApproved() public {
        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);
        vm.prank(acme);
        vm.expectRevert(); // SafeERC20 insufficient allowance
        claim.sell(bid, sig, bytes32(0));
    }

    function test_SecondaryResaleBetweenFinanciers() public {
        uint256 id = _issue();
        _sell(id, acme, financier, financierPk, 9_700e6, bytes32("bid1"));
        _sell(id, financier, financier2, financier2Pk, 9_850e6, bytes32("bid2"));
        assertEq(claim.ownerOf(id), financier2);
    }

    // ------------------------------------------------- sale: the buyer's consent
    //
    // `sell` used to take buyer and price as plain arguments, so any eligible
    // holder could spend any financier's standing allowance: issue a claim
    // against a made-up debtor, name the financier as buyer and their whole
    // allowance as price. These tests pin down that the buyer's signature, and
    // only the buyer's signature, decides who pays what for which claim.

    /// The reported attack, end to end: a standing allowance, a worthless
    /// claim, no bid. It must not move a single unit.
    function test_RevertWhen_HolderSpendsAllowanceWithoutABid() public {
        vm.prank(financier);
        fusd.approve(address(claim), 250_000e6); // script/Approve.s.sol default

        vm.prank(acme);
        uint256 id = claim.issue(address(0xDEAD), 1e6, dueDate, bytes32(0));

        InvoiceClaim.Bid memory forged = InvoiceClaim.Bid({
            claimId: id,
            buyer: financier,
            price: 250_000e6,
            deadline: uint64(block.timestamp + 60),
            nonce: bytes32(0)
        });
        uint256 finBefore = fusd.balanceOf(financier);

        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        claim.sell(forged, "", bytes32(0));

        // A signature by anyone other than the buyer is no better.
        (, uint256 acmePk) = makeAddrAndKey("acme-key");
        bytes memory wrongSigner = _sign(forged, acmePk);
        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        claim.sell(forged, wrongSigner, bytes32(0));

        assertEq(fusd.balanceOf(financier), finBefore, "financier must keep every unit");
        assertEq(claim.ownerOf(id), acme);
    }

    function test_RevertWhen_HolderRaisesTheSignedPrice() public {
        uint256 id = _issue();
        vm.prank(financier);
        fusd.approve(address(claim), 250_000e6);

        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);
        bid.price = 10_000e6;

        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        claim.sell(bid, sig, bytes32(0));
    }

    /// A bid for one claim cannot buy another, e.g. a worthless one the same
    /// holder issued a moment later.
    function test_RevertWhen_BidIsUsedOnAnotherClaim() public {
        uint256 good = _issue();
        uint256 junk = _issue();
        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);

        InvoiceClaim.Bid memory bid = _bid(good, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);
        bid.claimId = junk;

        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        claim.sell(bid, sig, bytes32(0));
    }

    /// Financier 2 cannot volunteer financier 1's money.
    function test_RevertWhen_BidIsSignedByAnotherFinancier() public {
        uint256 id = _issue();
        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);

        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financier2Pk);

        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        claim.sell(bid, sig, bytes32(0));
    }

    /// The deadline is the on-chain half of the Arkiv lifetime: a quote that
    /// has stopped being listed has also stopped being executable.
    function test_RevertWhen_BidHasExpired() public {
        uint256 id = _issue();
        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);
        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);

        vm.warp(uint256(bid.deadline) + 1);
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.BidExpired.selector, bid.deadline));
        claim.sell(bid, sig, bytes32(0));
    }

    function test_Sell_StillValidAtExactDeadline() public {
        uint256 id = _issue();
        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);
        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);

        vm.warp(bid.deadline);
        vm.prank(acme);
        claim.sell(bid, sig, bytes32(0));
        assertEq(claim.ownerOf(id), financier);
    }

    /// A filled bid is spent. If the claim finds its way back to the seller,
    /// the old signature cannot make the financier buy it a second time.
    function test_RevertWhen_BidIsReplayed() public {
        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _sell(id, acme, financier, financierPk, 9_700e6, bytes32(0));
        bytes memory sig = _sign(bid, financierPk);

        vm.prank(financier);
        claim.transferFrom(financier, acme, id);
        vm.prank(financier);
        fusd.approve(address(claim), 9_700e6);

        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.BidAlreadyUsed.selector, bid.nonce));
        claim.sell(bid, sig, bytes32(0));
    }

    /// The EIP-712 domain binds a signature to this deployment, so a bid
    /// signed for one InvoiceClaim cannot be filled on another.
    function test_RevertWhen_BidIsReplayedOnAnotherDeployment() public {
        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _bid(id, financier, 9_700e6);
        bytes memory sig = _sign(bid, financierPk);

        vm.prank(platform);
        InvoiceClaim other = new InvoiceClaim(IERC20(address(fusd)));
        address[] memory allowed = new address[](2);
        allowed[0] = acme;
        allowed[1] = financier;
        vm.prank(platform);
        other.setEligibleBatch(allowed, true);
        vm.prank(acme);
        other.issue(debtor, FACE, dueDate, bytes32(0));
        vm.prank(financier);
        fusd.approve(address(other), 9_700e6);

        vm.prank(acme);
        vm.expectRevert(InvoiceClaim.BadBidSignature.selector);
        other.sell(bid, sig, bytes32(0));
    }

    /// Pins the typed-data layout the app signs (src/fuji/claim.ts). If this
    /// changes, every bid signed by the browser stops verifying.
    function test_HashBid_MatchesEip712Layout() public {
        InvoiceClaim.Bid memory bid = _bid(7, financier, 9_700e6);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Factor Invoice Claim"),
                keccak256("1"),
                block.chainid,
                address(claim)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Bid(uint256 claimId,address buyer,uint256 price,uint64 deadline,bytes32 nonce)"
                ),
                bid.claimId,
                bid.buyer,
                bid.price,
                bid.deadline,
                bid.nonce
            )
        );
        assertEq(claim.hashBid(bid), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    /// A financier operating from a contract wallet (a multisig, say) signs
    /// through ERC-1271 rather than ECDSA.
    function test_Sell_AcceptsContractWalletSignature() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("wallet-owner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);
        vm.prank(platform);
        claim.setEligible(address(wallet), true);
        fusd.mint(address(wallet), 9_700e6);
        vm.prank(address(wallet));
        fusd.approve(address(claim), 9_700e6);

        uint256 id = _issue();
        InvoiceClaim.Bid memory bid = _bid(id, address(wallet), 9_700e6);
        bytes memory sig = _sign(bid, ownerPk);

        vm.prank(acme);
        claim.sell(bid, sig, bytes32(0));
        assertEq(claim.ownerOf(id), address(wallet));
    }

    // -------------------------------------------------------------- settlement

    function test_Settle_PaysHolderAndBurns() public {
        uint256 id = _issue();
        _sell(id, acme, financier, financierPk, 9_700e6, bytes32("bid"));

        vm.prank(debtor);
        fusd.approve(address(claim), FACE);

        uint256 finBefore = fusd.balanceOf(financier);

        vm.expectEmit(true, true, false, true);
        emit Settled(id, financier, FACE);

        vm.prank(debtor);
        claim.settle(id);

        assertEq(fusd.balanceOf(financier), finBefore + FACE, "holder receives full face value");
        assertFalse(claim.isOutstanding(id));
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id)
        );
        claim.ownerOf(id);
    }

    /// A matured claim cannot be traded but MUST still be payable. If this test
    /// ever fails, the hook is over-reaching and real invoices would be stranded.
    function test_Settle_StillWorksAfterMaturity() public {
        uint256 id = _issue();
        vm.warp(uint256(dueDate) + 10 days);

        vm.prank(debtor);
        fusd.approve(address(claim), FACE);
        vm.prank(debtor);
        claim.settle(id);

        assertFalse(claim.isOutstanding(id));
    }

    function test_RevertWhen_SettlingTwice() public {
        uint256 id = _issue();
        vm.prank(debtor);
        fusd.approve(address(claim), FACE * 2);
        vm.prank(debtor);
        claim.settle(id);

        vm.prank(debtor);
        vm.expectRevert(); // token burned - _requireOwned reverts first
        claim.settle(id);
    }

    function test_RevertWhen_SettlerIsNotDebtor() public {
        uint256 id = _issue();
        vm.prank(financier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotDebtor.selector, financier));
        claim.settle(id);
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_SellThenSettleConservesValue(uint128 faceRaw, uint128 priceRaw) public {
        uint256 face = uint256(faceRaw) + 1; // non-zero
        uint256 price = uint256(priceRaw);
        vm.assume(price <= 1_000_000e6);

        vm.prank(acme);
        uint256 id = claim.issue(debtor, face, dueDate, bytes32(0));

        _sell(id, acme, financier, financierPk, price, bytes32(0));

        fusd.mint(debtor, face);
        vm.prank(debtor);
        fusd.approve(address(claim), face);

        uint256 finBefore = fusd.balanceOf(financier);
        vm.prank(debtor);
        claim.settle(id);

        // The financier's return is exactly face value, whatever they paid.
        assertEq(fusd.balanceOf(financier), finBefore + face);
    }

    function testFuzz_EligibilityGateIsTotal(address who) public {
        vm.assume(who != address(0));
        vm.assume(who != acme && who != financier && who != financier2 && who != debtor);
        vm.assume(who.code.length == 0); // skip contracts that reject ERC721

        uint256 id = _issue();
        vm.prank(acme);
        vm.expectRevert(abi.encodeWithSelector(InvoiceClaim.NotEligible.selector, who));
        claim.transferFrom(acme, who, id);
    }
}

/// Minimal ERC-1271 wallet: valid when its single owner signed the hash.
contract MockERC1271Wallet {
    address internal immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        return ECDSA.recover(hash, signature) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
