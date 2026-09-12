// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {IO1FeeEscrow} from "../src/interfaces/IO1FeeEscrow.sol";

/// @notice Deploys the factory (and, through its constructor, the splitter implementation) on one chain.
///
///   O1_FEE_ESCROW=0x…  TREASURY=0x…  PLATFORM_BPS=2000  OWNER=0x… \
///   forge script script/Deploy.s.sol --rpc-url $RPC --private-key $PK --broadcast
///
/// `O1_FEE_ESCROW` is the active o1 FeeEscrow of that chain (config/o1.json → chains.<key>.contracts.feeEscrow).
contract Deploy is Script {
    function run() external {
        IO1FeeEscrow escrow = IO1FeeEscrow(vm.envAddress("O1_FEE_ESCROW"));
        address treasury = vm.envAddress("TREASURY");
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(2_000)));
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();
        FeeSplitterFactory factory = new FeeSplitterFactory(escrow, treasury, platformBps, owner);
        vm.stopBroadcast();

        console.log("FeeSplitterFactory", address(factory));
        console.log("FeeSplitter implementation", factory.implementation());
        console.log("o1 FeeEscrow", address(escrow));
        console.log("treasury", treasury);
        console.log("platformBps", platformBps);
        console.log("owner", owner);
    }
}
