// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IO1FeeEscrow} from "../../src/interfaces/IO1FeeEscrow.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";

interface IMockToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev o1's FeeEscrow as the splitter sees it: a ledger per (recipient, currency), claims pay the whole balance.
contract MockO1Escrow is IO1FeeEscrow {
    mapping(address => mapping(address => uint256)) private _owed;

    function credit(address recipient, address currency, uint256 amount) external payable {
        if (currency == address(0)) require(msg.value == amount, "native amount");
        else require(IMockToken(currency).transferFrom(msg.sender, address(this), amount), "pull");
        _owed[recipient][currency] += amount;
    }

    function owed(address recipient, address currency) external view returns (uint256) {
        return _owed[recipient][currency];
    }

    function claimTo(address currency, address destination) external {
        _pay(msg.sender, currency, destination);
    }

    function claimFor(address recipient, address currency) external {
        _pay(recipient, currency, recipient);
    }

    function _pay(address recipient, address currency, address destination) private {
        uint256 amount = _owed[recipient][currency];
        _owed[recipient][currency] = 0;
        if (amount == 0) return;
        if (currency == address(0)) {
            (bool ok,) = destination.call{value: amount}("");
            require(ok, "native send");
        } else {
            // Low-level so a token whose transfer returns nothing still works here.
            (bool ok, bytes memory data) =
                currency.call(abi.encodeWithSignature("transfer(address,uint256)", destination, amount));
            require(ok && (data.length == 0 || abi.decode(data, (bool))), "erc20 send");
        }
    }
}

/// @dev Minimal ERC-20 with configurable decimals.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A token whose `transfer` returns nothing (USDT style): callers that decode a bool see empty data.
contract QuietERC20 {
    string public name = "Tether";
    string public symbol = "USDT";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A recipient that refuses native transfers.
contract RevertingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev A recipient whose receive burns more gas than a push allows.
contract GasHog {
    uint256 public sink;

    receive() external payable {
        for (uint256 i = 0; i < 20_000; i++) {
            sink = i;
        }
    }
}

/// @dev A recipient that tries to claim again from inside its payout.
contract Reenterer {
    FeeSplitter public target;
    bool public reentered;
    bool public reentryReverted;

    function arm(FeeSplitter target_) external {
        target = target_;
    }

    receive() external payable {
        if (address(target) != address(0) && !reentered) {
            reentered = true;
            try target.claim(address(0)) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }
}
