#!/usr/bin/env node

import {
	startNode,
	startCollator,
	generateChainSpec,
	generateChainSpecRaw,
	exportGenesisWasm,
	exportGenesisState,
	startSimpleCollator,
	getParachainIdFromSpec,
} from "./spawn";
import { connect, setBalance, extendLeasePeriod } from "./rpc";
import { checkConfig } from "./check";
import {
	clearAuthorities,
	addAuthority,
	changeGenesisConfig,
	addGenesisParachain,
	addGenesisHrmpChannel,
	addBootNodes,
} from "./spec";
import { parachainAccount } from "./parachain";
import { ApiPromise } from "@polkadot/api";
import { randomAsHex } from "@polkadot/util-crypto";

import { resolve } from "path";
import fs from "fs";
import type {
	LaunchConfig,
	ResolvedParachainConfig,
	ResolvedSimpleParachainConfig,
	HrmpChannelsConfig,
	ResolvedLaunchConfig,
	RelayChainNodeConfig, ParachainNodeConfig
} from "./types";
import { keys as libp2pKeys } from "libp2p-crypto";
import { hexAddPrefix, hexStripPrefix, hexToU8a } from "@polkadot/util";
import PeerId from "peer-id";

function loadTypeDef(types: string | object): object {
	if (typeof types === "string") {
		// Treat types as a json file path
		try {
			const rawdata = fs.readFileSync(types, { encoding: "utf-8" });
			return JSON.parse(rawdata);
		} catch {
			console.error("failed to load parachain typedef file");
			process.exit(1);
		}
	} else {
		return types;
	}
}

// keep track of registered parachains
let registeredParachains: { [key: string]: boolean } = {};

export async function relay_run(config_dir: string, rawConfig: LaunchConfig) {
	// We need to reset that variable when running a new network
	registeredParachains = {};
	// Verify that the `config.json` has all the expected properties.
	if (!checkConfig(rawConfig)) {
		return;
	}
	const config = await resolveParachainId(config_dir, rawConfig);

	const relayChainBin = resolve(config_dir, config.relaychain.bin);
	if (!fs.existsSync(relayChainBin)) {
		console.error("Relay chain binary does not exist: ", relayChainBin);
		process.exit();
	}
	const relayChain = config.relaychain.chain;
	const relayChainRawSpec = resolve(`${relayChain}.relay.raw.json`);
	const chainRawSpecExists = fs.existsSync(relayChainRawSpec);
	if ((!config.reuseChainSpec && chainRawSpecExists) || !chainRawSpecExists) {
		const relayChainSpec = `${relayChain}.relay.json`;

		await generateChainSpec(relayChainBin, relayChain, `${relayChain}.relay.json`);
	
		if (config.relaychain.genesis) {
			await changeGenesisConfig(`${relayChain}.relay.json`, config.relaychain.genesis);
		}
		await addParachainsToGenesis(
			config_dir,
			relayChainSpec,
			config.parachains,
			config.simpleParachains
		);
		if (config.hrmpChannels) {
			await addHrmpChannelsToGenesis(relayChainSpec, config.hrmpChannels);
		}
		const bootNodes = await generateNodeKeys(config.relaychain.nodes);
		await addBootNodes(relayChainSpec, bootNodes);

		// -- End Chain Spec Modify --
		await generateChainSpecRaw(relayChainBin, resolve(`${relayChain}.relay.json`), `${relayChain}.relay.raw.json`);
	} else {
		console.log(`\`reuseChainSpec\` flag enabled, will use existing \`${relayChain}.relay.raw.json\`, delete it if you don't want to reuse`);
	}

	// First we launch each of the validators for the relay chain.
	for (const node of config.relaychain.nodes) {
		const { name, wsPort, rpcPort, port, flags, basePath, nodeKey } = node;
		console.log(
			`Starting Relaychain Node ${name}... wsPort: ${wsPort} rpcPort: ${rpcPort} port: ${port} nodeKey: ${nodeKey}`
		);
		// We spawn a `child_process` starting a node, and then wait until we
		// able to connect to it using PolkadotJS in order to know its running.
		startNode(
			relayChainBin,
			name,
			wsPort,
			rpcPort,
			port,
			nodeKey!, // by the time the control flow gets here it should be assigned.
			relayChainRawSpec,
			flags,
			basePath
		);
	}

	console.log("🚀 POLKADOT LAUNCH COMPLETE 🚀");
}

interface GenesisParachain {
	isSimple: boolean;
	id?: string;
	resolvedId: string;
	chain?: string;
	bin: string;
}

async function addParachainsToGenesis(
	config_dir: string,
	spec: string,
	parachains: ResolvedParachainConfig[],
	simpleParachains: ResolvedSimpleParachainConfig[]
) {
	console.log("\n⛓ Adding Genesis Parachains");

	// Collect all paras into a single list
	let x: GenesisParachain[] = parachains.map((p) => {
		return { isSimple: false, ...p };
	});
	let y: GenesisParachain[] = simpleParachains.map((p) => {
		return { isSimple: true, ...p };
	});
	let paras = x.concat(y);

	for (const parachain of paras) {
		const { isSimple, id, resolvedId, chain } = parachain;
		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		// If it isn't registered yet, register the parachain in genesis
		if (!registeredParachains[resolvedId]) {
			// Get the information required to register the parachain in genesis.
			let genesisState: string;
			let genesisWasm: string;
			try {
				if (isSimple) {
					// adder-collator does not support `--parachain-id` for export-genesis-state (and it is
					// not necessary for it anyway), so we don't pass it here.
					genesisState = await exportGenesisState(bin);
					genesisWasm = await exportGenesisWasm(bin);
				} else {
					genesisState = await exportGenesisState(bin, id, chain);
					genesisWasm = await exportGenesisWasm(bin, chain);
				}
			} catch (err) {
				console.error(err);
				process.exit(1);
			}

			await addGenesisParachain(
				spec,
				resolvedId,
				genesisState,
				genesisWasm,
				true
			);
			registeredParachains[resolvedId] = true;
		}
	}
}

async function addHrmpChannelsToGenesis(
	spec: string,
	hrmpChannels: HrmpChannelsConfig[]
) {
	console.log("⛓ Adding Genesis HRMP Channels");
	for (const hrmpChannel of hrmpChannels) {
		await addGenesisHrmpChannel(spec, hrmpChannel);
	}
}

// Resolves parachain id from chain spec if not specified
async function resolveParachainId(
	config_dir: string,
	config: LaunchConfig
): Promise<ResolvedLaunchConfig> {
	console.log(`\n🧹 Resolving parachain id...`);
	const resolvedConfig = config as ResolvedLaunchConfig;
	for (const parachain of resolvedConfig.parachains) {
		if (parachain.id) {
			parachain.resolvedId = parachain.id;
		} else {
			const bin = resolve(config_dir, parachain.bin);
			const paraId = await getParachainIdFromSpec(bin, parachain.chain);
			console.log(`  ✓ Read parachain id for ${parachain.bin}: ${paraId}`);
			parachain.resolvedId = paraId.toString();
		}
	}
	for (const parachain of resolvedConfig.simpleParachains) {
		parachain.resolvedId = parachain.id;
	}
	return resolvedConfig;
}

async function generateNodeKeys(
	nodes: RelayChainNodeConfig[] | ParachainNodeConfig[]
): Promise<string[]> {
	let bootNodes = [];
	for (const node of nodes) {
		if (!node.nodeKey) {
			node.nodeKey = hexStripPrefix(randomAsHex(32));
		}

		let pair = await libp2pKeys.generateKeyPairFromSeed(
			"Ed25519",
			hexToU8a(hexAddPrefix(node.nodeKey!)),
			1024
		);
		let peerId: PeerId = await PeerId.createFromPrivKey(pair.bytes);
		bootNodes.push(
			`/ip4/127.0.0.1/tcp/${node.port}/p2p/${peerId.toB58String()}`
		);
	}

	return bootNodes;
}
