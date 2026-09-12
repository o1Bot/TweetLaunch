// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {IO1FeeEscrow} from "../src/interfaces/IO1FeeEscrow.sol";

/// @notice Deploys the factory (and, through its constructor, the splitter implementation) on one chain.
/// Run through `pnpm contracts:deploy <chain> [--broadcast]` (scripts/deploy.ts), which fills the environment:
///
///   O1_FEE_ESCROW             the active o1 FeeEscrow of the chain (config/o1.json)
///   TREASURY, OWNER           FEE_SPLITTER_TREASURY / FEE_SPLITTER_OWNER
///   PLATFORM_BPS              FEE_SPLITTER_PLATFORM_BPS (default 2000)
///   FEE_SPLITTER_DEPLOYER_KEY the gas payer's private key, used for the broadcast
contract Deploy is Script {
    function run() external {
        IO1FeeEscrow escrow = IO1FeeEscrow(vm.envAddress("O1_FEE_ESCROW"));
        address treasury = vm.envAddress("TREASURY");
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(2_000)));
        uint256 deployerKey = vm.envUint("FEE_SPLITTER_DEPLOYER_KEY");
        address owner = vm.envOr("OWNER", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);
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
