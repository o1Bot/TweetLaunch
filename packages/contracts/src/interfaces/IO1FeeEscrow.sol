// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The part of o1 Launchpad's FeeEscrow a fee recipient uses. The escrow keeps one balance per
/// (recipient, currency): the hook credits it on every swap, and the recipient (or anyone, for the
/// recipient) claims the whole balance of a currency at once. Currency address(0) is the chain's native asset.
interface IO1FeeEscrow {
    function owed(address recipient, address currency) external view returns (uint256);
    /// @dev Pays msg.sender's balance of `currency` to `destination`.
    function claimTo(address currency, address destination) external;
    /// @dev Pays `recipient`'s balance of `currency` to `recipient`; callable by anyone.
    function claimFor(address recipient, address currency) external;
}
