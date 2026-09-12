// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {FeeSplitter} from "./FeeSplitter.sol";
import {IO1FeeEscrow} from "./interfaces/IO1FeeEscrow.sol";

/// @dev What a splitter clone reads from its factory.
interface IFeeSplitterFactory {
    function o1Escrow() external view returns (IO1FeeEscrow);
    function treasury() external view returns (address);
    function owner() external view returns (address);
}

/// @title FeeSplitterFactory
/// @notice One per chain. Deploys a deterministic FeeSplitter clone per launch, so the clone's address can be
/// passed as o1's `creatorFeeRecipient` before the clone exists: fees accrue to the address in o1's escrow
/// either way, and `register` with the same configuration always lands on the same address.
///
/// The platform share is fixed into every clone at registration (and into its address), so changing it here
/// only affects launches registered afterwards; the treasury address is read live by every clone.
contract FeeSplitterFactory is Ownable2Step, IFeeSplitterFactory {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_PLATFORM_BPS = 3_000;
    uint256 public constant MAX_RECIPIENTS = 8;

    IO1FeeEscrow public immutable override o1Escrow;
    address public immutable implementation;
    address public override treasury;
    /// @notice Platform share, in basis points, applied to launches registered from now on.
    uint16 public platformBps;

    event TreasuryChanged(address indexed treasury);
    event PlatformBpsChanged(uint16 platformBps);
    event Registered(
        address indexed splitter, address indexed token, address[] recipients, uint16[] shares, uint16 platformBps
    );

    error ZeroAddress();
    error PlatformBpsTooHigh();
    error BadRecipients();
    error BadShares();

    constructor(IO1FeeEscrow o1Escrow_, address treasury_, uint16 platformBps_, address initialOwner)
        Ownable(initialOwner)
    {
        if (address(o1Escrow_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (platformBps_ > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh();
        o1Escrow = o1Escrow_;
        treasury = treasury_;
        platformBps = platformBps_;
        implementation = address(new FeeSplitter(this));
    }

    /// @dev Both Ownable and the clone-facing interface declare it.
    function owner() public view override(Ownable, IFeeSplitterFactory) returns (address) {
        return super.owner();
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function setPlatformBps(uint16 platformBps_) external onlyOwner {
        if (platformBps_ > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh();
        platformBps = platformBps_;
        emit PlatformBpsChanged(platformBps_);
    }

    /// @notice The salt a configuration maps to; the address follows from it.
    function computeSalt(address token, address[] calldata recipients, uint16[] calldata shares, uint16 platformBps_)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(token, recipients, shares, platformBps_));
    }

    /// @notice Where the splitter for this configuration lives, deployed or not.
    function predict(address token, address[] calldata recipients, uint16[] calldata shares, uint16 platformBps_)
        external
        view
        returns (address)
    {
        return Clones.predictDeterministicAddress(implementation, computeSalt(token, recipients, shares, platformBps_));
    }

    /// @notice Deploy the splitter for a launch with the current platform share. Anyone may call it; calling it
    /// again for the same configuration returns the existing clone.
    function register(address token, address[] calldata recipients, uint16[] calldata shares)
        external
        returns (address splitter)
    {
        return registerWith(token, recipients, shares, platformBps);
    }

    /// @notice Same as `register` for a platform share fixed earlier (a launch registered before a change).
    function registerWith(address token, address[] calldata recipients, uint16[] calldata shares, uint16 platformBps_)
        public
        returns (address splitter)
    {
        _validate(recipients, shares);
        if (platformBps_ > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh();
        bytes32 salt = computeSalt(token, recipients, shares, platformBps_);
        splitter = Clones.predictDeterministicAddress(implementation, salt);
        if (splitter.code.length > 0) return splitter;
        Clones.cloneDeterministic(implementation, salt);
        FeeSplitter(payable(splitter)).initialize(token, recipients, shares, platformBps_);
        emit Registered(splitter, token, recipients, shares, platformBps_);
    }

    /// @notice Sweep a splitter's undistributable balance (never a recipient's pending payout).
    function rescue(FeeSplitter splitter, address currency, address to) external onlyOwner {
        splitter.rescue(currency, to);
    }

    function _validate(address[] calldata recipients, uint16[] calldata shares) private pure {
        uint256 n = recipients.length;
        if (n == 0 || n > MAX_RECIPIENTS || shares.length != n) revert BadRecipients();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            if (recipients[i] == address(0)) revert BadRecipients();
            if (shares[i] == 0) revert BadShares();
            for (uint256 j = 0; j < i; j++) {
                if (recipients[j] == recipients[i]) revert BadRecipients();
            }
            sum += shares[i];
        }
        if (sum != BPS) revert BadShares();
    }
}
