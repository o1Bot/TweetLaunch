// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {GasHog, MockERC20, MockO1Escrow, QuietERC20, Reenterer, RevertingReceiver} from "./mocks/Mocks.sol";

contract FeeSplitterTest is Test {
    address constant NATIVE = address(0);
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address token = makeAddr("token");
    address anyone = makeAddr("anyone");

    MockO1Escrow escrow;
    FeeSplitterFactory factory;
    MockERC20 usdc;
    MockERC20 stock;
    QuietERC20 usdt;

    function setUp() public {
        escrow = new MockO1Escrow();
        factory = new FeeSplitterFactory(escrow, treasury, 2_000, owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock = new MockERC20("Space Exploration", "SPCX", 8);
        usdt = new QuietERC20();
        vm.deal(anyone, 100 ether);
    }

    function _one(address a) internal pure returns (address[] memory r, uint16[] memory s) {
        r = new address[](1);
        s = new uint16[](1);
        r[0] = a;
        s[0] = 10_000;
    }

    function _two(address a, uint16 sa, address b, uint16 sb)
        internal
        pure
        returns (address[] memory r, uint16[] memory s)
    {
        r = new address[](2);
        s = new uint16[](2);
        r[0] = a;
        r[1] = b;
        s[0] = sa;
        s[1] = sb;
    }

    function _creditNative(address recipient, uint256 amount) internal {
        vm.prank(anyone);
        escrow.credit{value: amount}(recipient, NATIVE, amount);
    }

    function _creditToken(address t, address recipient, uint256 amount) internal {
        (bool ok,) = t.call(abi.encodeWithSignature("mint(address,uint256)", anyone, amount));
        require(ok, "mint");
        vm.startPrank(anyone);
        (ok,) = t.call(abi.encodeWithSignature("approve(address,uint256)", address(escrow), amount));
        require(ok, "approve");
        escrow.credit(recipient, t, amount);
        vm.stopPrank();
    }

    // ── registration ──────────────────────────────────────────────────────

    function test_predictMatchesRegisterAndIsIdempotent() public {
        (address[] memory r, uint16[] memory s) = _two(alice, 2_000, bob, 8_000);
        address predicted = factory.predict(token, r, s, 2_000);
        assertEq(predicted.code.length, 0);
        address splitter = factory.register(token, r, s);
        assertEq(splitter, predicted);
        assertGt(splitter.code.length, 0);
        assertEq(factory.register(token, r, s), splitter);
        FeeSplitter fs = FeeSplitter(payable(splitter));
        assertEq(fs.token(), token);
        assertEq(fs.platformBps(), 2_000);
        assertEq(fs.recipients()[1], bob);
        assertEq(fs.shares()[0], 2_000);
    }

    function test_feesAccrueBeforeDeployment() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        address predicted = factory.predict(token, r, s, 2_000);
        _creditNative(predicted, 1 ether);
        assertEq(escrow.owed(predicted, NATIVE), 1 ether);
        factory.register(token, r, s);
        FeeSplitter(payable(predicted)).claim(NATIVE);
        assertEq(alice.balance, 0.8 ether);
        assertEq(treasury.balance, 0.2 ether);
    }

    function test_registerRejectsBadConfigurations() public {
        address[] memory r = new address[](0);
        uint16[] memory s = new uint16[](0);
        vm.expectRevert(FeeSplitterFactory.BadRecipients.selector);
        factory.register(token, r, s);

        (r, s) = _two(alice, 5_000, bob, 4_000);
        vm.expectRevert(FeeSplitterFactory.BadShares.selector);
        factory.register(token, r, s);

        (r, s) = _two(alice, 5_000, alice, 5_000);
        vm.expectRevert(FeeSplitterFactory.BadRecipients.selector);
        factory.register(token, r, s);

        (r, s) = _two(alice, 10_000, bob, 0);
        vm.expectRevert(FeeSplitterFactory.BadShares.selector);
        factory.register(token, r, s);

        (r, s) = _one(address(0));
        vm.expectRevert(FeeSplitterFactory.BadRecipients.selector);
        factory.register(token, r, s);

        (r, s) = _one(alice);
        vm.expectRevert(FeeSplitterFactory.PlatformBpsTooHigh.selector);
        factory.registerWith(token, r, s, 3_001);
    }

    function test_cloneCannotBeInitializedTwiceOrByOthers() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        vm.expectRevert(FeeSplitter.OnlyFactory.selector);
        fs.initialize(token, r, s, 0);
        vm.prank(address(factory));
        vm.expectRevert(FeeSplitter.AlreadyInitialized.selector);
        fs.initialize(token, r, s, 0);
        // The implementation is born initialized.
        FeeSplitter impl = FeeSplitter(payable(factory.implementation()));
        vm.prank(address(factory));
        vm.expectRevert(FeeSplitter.AlreadyInitialized.selector);
        impl.initialize(token, r, s, 0);
    }

    // ── claims ────────────────────────────────────────────────────────────

    function test_claimSplitsNativeWithPlatformShareAndRemainderToLast() public {
        (address[] memory r, uint16[] memory s) = _two(alice, 2_000, bob, 8_000);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        uint256 total = 1 ether + 1; // an odd wei to see the remainder land somewhere
        _creditNative(address(fs), total);
        assertEq(fs.claimable(NATIVE), total);
        uint256 distributed = fs.claim(NATIVE);
        assertEq(distributed, total);
        uint256 platform = (total * 2_000) / 10_000;
        uint256 rest = total - platform;
        assertEq(treasury.balance, platform);
        assertEq(alice.balance, (rest * 2_000) / 10_000);
        assertEq(bob.balance, rest - (rest * 2_000) / 10_000);
        assertEq(address(fs).balance, 0);
        assertEq(fs.claimable(NATIVE), 0);
    }

    function test_claimSplitsSixAndEightDecimalTokens() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditToken(address(usdc), address(fs), 5_000_000); // 5 USDC
        _creditToken(address(stock), address(fs), 123_456_789); // 1.23456789 SPCX
        fs.claim(address(usdc));
        fs.claim(address(stock));
        assertEq(usdc.balanceOf(alice), 4_000_000);
        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(stock.balanceOf(alice), 98_765_432);
        assertEq(stock.balanceOf(treasury), 24_691_357);
        assertEq(usdc.balanceOf(address(fs)), 0);
        assertEq(stock.balanceOf(address(fs)), 0);
    }

    function test_claimAcceptsQuietErc20Transfers() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditToken(address(usdt), address(fs), 1_000_000);
        fs.claim(address(usdt));
        assertEq(usdt.balanceOf(alice), 800_000);
        assertEq(usdt.balanceOf(treasury), 200_000);
    }

    function test_claimDistributesWhatAThirdPartyClaimedForTheSplitter() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditNative(address(fs), 2 ether);
        vm.prank(anyone);
        escrow.claimFor(address(fs), NATIVE); // lands on the splitter without distributing
        assertEq(address(fs).balance, 2 ether);
        assertEq(escrow.owed(address(fs), NATIVE), 0);
        fs.claim(NATIVE);
        assertEq(alice.balance, 1.6 ether);
        assertEq(treasury.balance, 0.4 ether);
    }

    function test_claimWithNothingIsANoop() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        assertEq(fs.claim(NATIVE), 0);
        assertEq(fs.claim(address(usdc)), 0);
    }

    function test_zeroPlatformShareSendsEverythingToRecipients() public {
        vm.prank(owner);
        factory.setPlatformBps(0);
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE);
        assertEq(alice.balance, 1 ether);
        assertEq(treasury.balance, 0);
    }

    // ── deferred payouts, withdrawals, rescue ─────────────────────────────

    function test_failedPushIsDeferredAndWithdrawable() public {
        RevertingReceiver bad = new RevertingReceiver();
        (address[] memory r, uint16[] memory s) = _two(address(bad), 5_000, alice, 5_000);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE);
        assertEq(alice.balance, 0.4 ether);
        assertEq(treasury.balance, 0.2 ether);
        assertEq(fs.pending(NATIVE, address(bad)), 0.4 ether);
        assertEq(fs.totalPending(NATIVE), 0.4 ether);
        assertEq(address(fs).balance, 0.4 ether);
        // Nobody else can take it: rescue sees nothing distributable, a stranger has nothing to withdraw.
        vm.prank(owner);
        vm.expectRevert(FeeSplitter.NothingToRescue.selector);
        fs.rescue(NATIVE, owner);
        vm.prank(anyone);
        vm.expectRevert(FeeSplitter.NothingToWithdraw.selector);
        fs.withdraw(NATIVE);
        // The recipient itself still cannot receive, so its withdrawal reverts rather than burning the funds.
        vm.prank(address(bad));
        vm.expectRevert(FeeSplitter.TransferFailed.selector);
        fs.withdraw(NATIVE);
        assertEq(fs.pending(NATIVE, address(bad)), 0.4 ether);
    }

    function test_gasHungryRecipientIsDeferredNotBlocking() public {
        GasHog hog = new GasHog();
        (address[] memory r, uint16[] memory s) = _two(address(hog), 5_000, alice, 5_000);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE);
        assertEq(alice.balance, 0.4 ether);
        assertEq(fs.pending(NATIVE, address(hog)), 0.4 ether);
    }

    function test_reentrantRecipientCannotClaimTwice() public {
        Reenterer re = new Reenterer();
        (address[] memory r, uint16[] memory s) = _two(address(re), 5_000, alice, 5_000);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        re.arm(fs);
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE);
        assertTrue(re.reentered());
        assertTrue(re.reentryReverted());
        // The reentrant receive spent its gas budget, so its share sits in pending; nothing was paid twice.
        assertEq(alice.balance, 0.4 ether);
        assertEq(treasury.balance, 0.2 ether);
        assertEq(address(re).balance + fs.pending(NATIVE, address(re)), 0.4 ether);
        assertEq(address(fs).balance, fs.totalPending(NATIVE));
    }

    function test_rescueSweepsOnlyWhatIsOwedToNobody() public {
        RevertingReceiver bad = new RevertingReceiver();
        (address[] memory r, uint16[] memory s) = _one(address(bad));
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE); // 0.8 deferred to `bad`, 0.2 to the treasury
        vm.deal(address(fs), address(fs).balance + 0.5 ether); // a stray transfer
        assertEq(fs.totalPending(NATIVE), 0.8 ether);
        vm.prank(anyone);
        vm.expectRevert(FeeSplitter.OnlyFactoryOwner.selector);
        fs.rescue(NATIVE, anyone);
        vm.prank(owner);
        factory.rescue(fs, NATIVE, owner);
        assertEq(owner.balance, 0.5 ether);
        assertEq(address(fs).balance, 0.8 ether);
        assertEq(fs.pending(NATIVE, address(bad)), 0.8 ether);
    }

    function test_rescueSweepsStrayTokens() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        usdc.mint(address(fs), 7_000_000);
        vm.prank(owner);
        factory.rescue(fs, address(usdc), owner);
        assertEq(usdc.balanceOf(owner), 7_000_000);
    }

    // ── factory administration ────────────────────────────────────────────

    function test_treasuryChangeAppliesToExistingSplitters() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        address treasury2 = makeAddr("treasury2");
        vm.prank(owner);
        factory.setTreasury(treasury2);
        _creditNative(address(fs), 1 ether);
        fs.claim(NATIVE);
        assertEq(treasury2.balance, 0.2 ether);
        assertEq(treasury.balance, 0);
    }

    function test_platformBpsChangeOnlyAffectsNewRegistrations() public {
        (address[] memory r, uint16[] memory s) = _one(alice);
        FeeSplitter early = FeeSplitter(payable(factory.register(token, r, s)));
        vm.prank(owner);
        factory.setPlatformBps(1_000);
        address later = factory.register(makeAddr("token2"), r, s);
        assertEq(early.platformBps(), 2_000);
        assertEq(FeeSplitter(payable(later)).platformBps(), 1_000);
        // The old configuration is still reachable through registerWith, at its own address.
        assertEq(factory.registerWith(token, r, s, 2_000), address(early));
        assertTrue(factory.predict(token, r, s, 1_000) != address(early));
    }

    function test_onlyOwnerAdministers() public {
        vm.startPrank(anyone);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), anyone));
        factory.setTreasury(anyone);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), anyone));
        factory.setPlatformBps(0);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(FeeSplitterFactory.PlatformBpsTooHigh.selector);
        factory.setPlatformBps(3_001);
        vm.prank(owner);
        vm.expectRevert(FeeSplitterFactory.ZeroAddress.selector);
        factory.setTreasury(address(0));
    }

    function testFuzz_splitAlwaysAddsUp(uint16 shareA, uint96 amount) public {
        shareA = uint16(bound(shareA, 1, 9_999));
        amount = uint96(bound(amount, 1, type(uint96).max));
        (address[] memory r, uint16[] memory s) = _two(alice, shareA, bob, 10_000 - shareA);
        FeeSplitter fs = FeeSplitter(payable(factory.register(token, r, s)));
        vm.deal(anyone, amount);
        _creditNative(address(fs), amount);
        fs.claim(NATIVE);
        assertEq(alice.balance + bob.balance + treasury.balance, amount);
        assertEq(address(fs).balance, 0);
    }
}
