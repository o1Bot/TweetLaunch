// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IO1FeeEscrow} from "./interfaces/IO1FeeEscrow.sol";
import {IFeeSplitterFactory} from "./FeeSplitterFactory.sol";

/// @title FeeSplitter
/// @notice The creator-fee recipient of one o1 launch. o1's escrow keeps fees per recipient address, so every
/// launch gets its own minimal clone of this contract; the clone pulls its balance from the escrow and pays
/// it out in the same transaction: the platform share to the factory's treasury, the rest to the launch's
/// recipients in their fixed proportions. Nothing stays here except payouts a recipient could not receive
/// (a contract that reverts), which wait in `pending` until that recipient withdraws them.
///
/// What nobody can change after `initialize`: the recipients, their shares and the platform share. What the
/// factory owner can do: point the treasury elsewhere (their own money) and sweep assets that are not owed
/// to anyone (`rescue`, which can never reach `pending`).
contract FeeSplitter is ReentrancyGuard {
    /// @dev o1's sentinel for the chain's native asset.
    address public constant NATIVE = address(0);
    uint16 public constant BPS = 10_000;
    /// @dev Gas a push payout may use; anything heavier is deferred to `pending` instead of blocking a claim.
    uint256 public constant PUSH_GAS = 100_000;

    /// @dev Set on the implementation; clones read it from the code they delegate to.
    IFeeSplitterFactory public immutable factory;

    address public token;
    address[] private _recipients;
    uint16[] private _shares;
    /// @notice Basis points of every claim that go to the platform treasury, fixed at registration.
    uint16 public platformBps;
    bool private _initialized;

    /// @notice Payouts that could not be pushed, per currency and account; withdrawn by the account.
    mapping(address currency => mapping(address account => uint256)) public pending;
    /// @notice Sum of `pending` per currency: the part of this contract's balance that is not distributable.
    mapping(address currency => uint256) public totalPending;

    event Initialized(address indexed token, address[] recipients, uint16[] shares, uint16 platformBps);
    event Claimed(address indexed currency, uint256 distributed, uint256 platformAmount);
    event Paid(address indexed currency, address indexed to, uint256 amount);
    event Deferred(address indexed currency, address indexed to, uint256 amount);
    event Withdrawn(address indexed currency, address indexed to, uint256 amount);
    event Rescued(address indexed currency, address indexed to, uint256 amount);

    error AlreadyInitialized();
    error OnlyFactory();
    error OnlyFactoryOwner();
    error NothingToWithdraw();
    error NothingToRescue();
    error TransferFailed();

    constructor(IFeeSplitterFactory factory_) {
        factory = factory_;
        // The implementation itself is never a recipient; clones start uninitialized.
        _initialized = true;
    }

    receive() external payable {}

    /// @notice Called once by the factory right after the clone is deployed.
    function initialize(address token_, address[] calldata recipients_, uint16[] calldata shares_, uint16 platformBps_)
        external
    {
        if (msg.sender != address(factory)) revert OnlyFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        token = token_;
        _recipients = recipients_;
        _shares = shares_;
        platformBps = platformBps_;
        emit Initialized(token_, recipients_, shares_, platformBps_);
    }

    function recipients() external view returns (address[] memory) {
        return _recipients;
    }

    function shares() external view returns (uint16[] memory) {
        return _shares;
    }

    /// @notice What a claim of `currency` would distribute right now: the escrow balance plus anything already here.
    function claimable(address currency) external view returns (uint256) {
        return factory.o1Escrow().owed(address(this), currency) + _distributable(currency);
    }

    /// @notice Pull this launch's `currency` fees from o1's escrow and pay everyone. Anyone may call it.
    /// @return distributed The amount paid out, platform share included.
    function claim(address currency) external nonReentrant returns (uint256 distributed) {
        IO1FeeEscrow escrow = factory.o1Escrow();
        if (escrow.owed(address(this), currency) > 0) escrow.claimTo(currency, address(this));
        distributed = _distributable(currency);
        if (distributed == 0) return 0;

        uint256 platformAmount = (distributed * platformBps) / BPS;
        if (platformAmount > 0) _pay(currency, factory.treasury(), platformAmount);

        uint256 rest = distributed - platformAmount;
        uint256 paid;
        uint256 last = _recipients.length - 1;
        for (uint256 i = 0; i <= last; i++) {
            // The last recipient takes the rounding remainder so the whole amount leaves.
            uint256 amount = i == last ? rest - paid : (rest * _shares[i]) / BPS;
            paid += amount;
            if (amount > 0) _pay(currency, _recipients[i], amount);
        }
        emit Claimed(currency, distributed, platformAmount);
    }

    /// @notice Take a payout that could not be pushed to the caller.
    function withdraw(address currency) external nonReentrant {
        uint256 amount = pending[currency][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pending[currency][msg.sender] = 0;
        totalPending[currency] -= amount;
        if (!_send(currency, msg.sender, amount, gasleft())) revert TransferFailed();
        emit Withdrawn(currency, msg.sender, amount);
    }

    /// @notice Sweep whatever is here and owed to nobody: sent by mistake, or a platform push that failed.
    /// Bounded by `balance - totalPending`, so a recipient's deferred payout is out of reach.
    function rescue(address currency, address to) external nonReentrant {
        if (msg.sender != factory.owner() && msg.sender != address(factory)) revert OnlyFactoryOwner();
        uint256 amount = _distributable(currency);
        if (amount == 0) revert NothingToRescue();
        if (!_send(currency, to, amount, gasleft())) revert TransferFailed();
        emit Rescued(currency, to, amount);
    }

    function _distributable(address currency) private view returns (uint256) {
        uint256 balance = currency == NATIVE ? address(this).balance : IERC20(currency).balanceOf(address(this));
        return balance - totalPending[currency];
    }

    /// @dev Push with bounded gas; a failed push becomes a pending balance the recipient pulls later.
    function _pay(address currency, address to, uint256 amount) private {
        if (_send(currency, to, amount, PUSH_GAS)) {
            emit Paid(currency, to, amount);
        } else {
            pending[currency][to] += amount;
            totalPending[currency] += amount;
            emit Deferred(currency, to, amount);
        }
    }

    /// @dev Native: plain call with the gas budget. ERC-20: `transfer`, accepting no return data as success
    /// (USDT-style tokens) and requiring `true` when data comes back.
    function _send(address currency, address to, uint256 amount, uint256 gas) private returns (bool ok) {
        if (currency == NATIVE) {
            (ok,) = to.call{value: amount, gas: gas}("");
            return ok;
        }
        bytes memory data;
        (ok, data) = currency.call{gas: gas}(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
