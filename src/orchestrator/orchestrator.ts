import {
  CreateLogTable,
  PARACHAIN_NOT_FOUND,
  POLKADOT_NOT_FOUND,
  POLKADOT_NOT_FOUND_DESCRIPTION,
  askQuestion,
  decorators,
  filterConsole,
  generateNamespace,
  getSha256,
  loadTypeDef,
  makeDir,
  series,
  setSilent,
  sleep,
} from "../utils";
import fs from "fs";
import { promises as fsPromises } from "fs";
import {
  addBootNodes,
  addParachainToGenesis,
  customizePlainRelayChain,
  readAndParseChainSpec,
} from "./chainSpec";
import {
  generateBootnodeSpec,
  generateNetworkSpec,
  zombieWrapperPath,
} from "./configGenerator";
import {
  GENESIS_STATE_FILENAME,
  GENESIS_WASM_FILENAME,
  TOKEN_PLACEHOLDER,
  ZOMBIE_WRAPPER,
} from "./constants";
import { registerParachain } from "./jsapi-helpers";
import { Network, Scope } from "./network";
import { generateParachainFiles } from "./paras";
import { getProvider } from "./providers/";
import {
  ComputedNetwork,
  LaunchConfig,
  Node,
  Parachain,
  fileMap,
} from "./types";

import { spawnIntrospector } from "./network-helpers/instrospector";
import { setTracingCollatorConfig } from "./network-helpers/tracing-collator";
import { nodeChecker, verifyNodes } from "./network-helpers/verifier";
import { Client } from "./providers/client";
import { spawnNode } from "./spawner";
import { setSubstrateCliArgsVersion } from "./substrateCliArgsHelper";

const debug = require("debug")("zombie");

// Hide some warning messages that are coming from Polkadot JS API.
// TODO: Make configurable.
filterConsole([
  `code: '1006' reason: 'connection failed'`,
  `API-WS: disconnected`,
]);

export interface OrcOptionsInterface {
  monitor?: boolean;
  spawnConcurrency?: number;
  inCI?: boolean;
  dir: string;
  force?: boolean;
  silent?: boolean; // Mute logging output
  setGlobalNetwork?: (network: Network) => void;
}

export async function start(
  credentials: string,
  launchConfig: LaunchConfig,
  options: OrcOptionsInterface,
) {
  const opts = {
    ...{ monitor: false, spawnConcurrency: 1, inCI: false, silent: true },
    ...options,
  };

  setSilent(opts.silent);
  let network: Network | undefined;
  let cronInterval = undefined;

  try {
    // Parse and build Network definition
    const networkSpec: ComputedNetwork = await generateNetworkSpec(
      launchConfig,
    );

    // IFF there are network references in cmds we need to switch to concurrency 1
    if (TOKEN_PLACEHOLDER.test(JSON.stringify(networkSpec))) {
      debug(
        "Network definition use network references, switching concurrency to 1",
      );
      opts.spawnConcurrency = 1;
    }

    debug(JSON.stringify(networkSpec, null, 4));

    const { initClient, getChainSpecRaw } = getProvider(
      networkSpec.settings.provider,
    );

    // global timeout to spin the network
    const timeoutTimer = setTimeout(() => {
      if (network && !network.launched) {
        throw new Error(
          `GLOBAL TIMEOUT (${networkSpec.settings.timeout} secs) `,
        );
      }
    }, networkSpec.settings.timeout * 1000);

    // set namespace
    const namespace = `zeeve`;

    // get user defined types
    const userDefinedTypes: any = loadTypeDef(networkSpec.types);

    // use provided dir (and make some validations) or create tmp directory to store needed files
    const dataDir = { path: opts.dir };

    // If custom path is provided then create it
    if (opts.dir) {
      if (!fs.existsSync(opts.dir)) {
        fs.mkdirSync(opts.dir);
      } else if (!opts.force) {
        const response = await askQuestion(
          decorators.yellow(
            "Directory already exists; \nDo you want to continue? (y/N)",
          ),
        );
        if (response.toLowerCase() !== "y") {
          console.log("Exiting...");
          process.exit(1);
        }
      }
    }

    // Define chain name and file name to use.

    const specs = {
      chainSpecFileName: `${networkSpec.relaychain.chain}.json`,
      chainName: networkSpec.relaychain.chain,
      chainSpecFullPath: `${dataDir.path}/${networkSpec.relaychain.chain}.json`,
      chainSpecFullPathPlain: `${dataDir.path}/${networkSpec.relaychain.chain}.json`.replace(
        ".json",
        "-plain.json",
      )
    }

    const client: Client = initClient(credentials, namespace, dataDir.path);

    if (networkSpec.settings.node_spawn_timeout)
      client.timeout = networkSpec.settings.node_spawn_timeout;
    network = new Network(client, namespace, dataDir.path);
    if (options?.setGlobalNetwork) {
      options.setGlobalNetwork(network);
    }

    const zombieTable = new CreateLogTable({
      head: [
        decorators.green("🧟 Zombienet 🧟"),
        decorators.green("Initiation"),
      ],
      colWidths: [20, 100],
      doubleBorder: true,
    });

    zombieTable.pushTo([
      [
        decorators.green("Provider"),
        decorators.blue(networkSpec.settings.provider),
      ],
      [decorators.green("Namespace"), namespace],
      [decorators.green("Temp Dir"), dataDir.path],
    ]);

    zombieTable.print();

    debug(`\t Launching network under namespace: ${namespace}`);

    // validate access to cluster
    const isValid = await client.validateAccess();
    if (!isValid) {
      console.error(
        `\n\t\t ${decorators.reverse(
          decorators.red("⚠ Can not access"),
        )} ${decorators.magenta(
          networkSpec.settings.provider,
        )}, please check your config.`,
      );
      process.exit(1);
    }

    // create namespace
    await client.createNamespace();

    // setup cleaner
    if (!opts.monitor) {
      cronInterval = await client.setupCleaner();
      debug("Cleanner job configured");
    }

    // Create bootnode and backchannel services
    debug(`Creating static resources (bootnode and backchannel services)`);
    // await client.staticSetup(networkSpec.settings);
    // await client.createPodMonitor("pod-monitor.yaml", chainName);

    // Set substrate client argument version, needed from breaking change.
    // see https://github.com/paritytech/substrate/pull/13384
    // await setSubstrateCliArgsVersion(networkSpec, client);

    // create or copy relay chain spec
    // await setupChainSpec(
    //   namespace,
    //   networkSpec.relaychain,
    //   specs,
    // );
    if (networkSpec.relaychain.chainSpecPath) {
      await fsPromises.copyFile(networkSpec.relaychain.chainSpecPath, specs.chainSpecFullPathPlain);
    }

    // check if we have the chain spec file
    if (!fs.existsSync(specs.chainSpecFullPathPlain))
      throw new Error("Can't find chain spec file!");

    // Check if the chain spec is in raw format
    // Could be if the chain_spec_path was set
    const chainSpecContent = readAndParseChainSpec(specs.chainSpecFullPathPlain);
    const relayChainSpecIsRaw = Boolean(chainSpecContent.genesis?.raw);

    network.chainId = chainSpecContent.id;
    
    /// sankar
    const parachainFilesPromiseGenerator = async (parachain: Parachain) => {
      const parachainFilesPath = `${dataDir.path}/${parachain.name}`;
      await makeDir(parachainFilesPath);
      await generateParachainFiles(
        namespace,
        dataDir.path,
        parachainFilesPath,
        specs.chainName,
        parachain,
        relayChainSpecIsRaw,
      );
    };

    const parachainPromiseGenerators = networkSpec.parachains.map(
      (parachain: Parachain) => {
        return () => parachainFilesPromiseGenerator(parachain);
      },
    );

    await series(parachainPromiseGenerators, opts.spawnConcurrency);

    for (const parachain of networkSpec.parachains) {
      const parachainFilesPath = `${dataDir.path}/${parachain.name}`;
      const stateLocalFilePath = `${parachainFilesPath}/${GENESIS_STATE_FILENAME}`;
      const wasmLocalFilePath = `${parachainFilesPath}/${GENESIS_WASM_FILENAME}`;
      if (parachain.addToGenesis && !relayChainSpecIsRaw)
        await addParachainToGenesis(
          specs.chainSpecFullPathPlain,
          parachain.id.toString(),
          stateLocalFilePath,
          wasmLocalFilePath,
        );
    }

    /// sankar
    
    if (!relayChainSpecIsRaw) {
      await customizePlainRelayChain(specs.chainSpecFullPathPlain, networkSpec);

      // generate the raw chain spec
      await getChainSpecRaw(
        namespace,
        networkSpec.relaychain.defaultImage,
        specs.chainName,
        networkSpec.relaychain.defaultCommand,
        specs.chainSpecFullPath,
      );
    } else {
      console.log(
        `\n\t\t 🚧 ${decorators.yellow(
          "Chain Spec was set to a file in raw format, can't customize.",
        )} 🚧`,
      );
      await fs.promises.copyFile(specs.chainSpecFullPathPlain, specs.chainSpecFullPath);
    }

    // ensure chain raw is ok
    try {
      const chainSpecContent = readAndParseChainSpec(specs.chainSpecFullPathPlain);
      debug(`Chain name: ${chainSpecContent.name}`);

      new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
        [`Chain name: ${decorators.green(chainSpecContent.name)}`],
      ]);
    } catch (err) {
      console.log(
        `\n ${decorators.red("Unexpected error: ")} \t ${decorators.bright(
          err,
        )}\n`,
      );
      throw new Error(
        `${decorators.red(`Error:`)} \t ${decorators.bright(
          ` chain-spec raw file at ${specs.chainSpecFullPath} is not a valid JSON`,
        )}`,
      );
    }

    // clear bootnodes
    await addBootNodes(specs.chainSpecFullPath, []);

    // store the chain spec path to use in tests
    network.chainSpecFullPath = specs.chainSpecFullPath;

    // files to include in each node
    const filesToCopyToNodes: fileMap[] = [
      {
        localFilePath: specs.chainSpecFullPath,
        remoteFilePath: `${client.remoteDir}/${specs.chainSpecFileName}`,
      }
    ];

    const bootnodes: string[] = [];

    if (launchConfig.settings.bootnode) {
      const bootnodeSpec = await generateBootnodeSpec(networkSpec);
      networkSpec.relaychain.nodes.unshift(bootnodeSpec);
    }

    const monitorIsAvailable = await client.isPodMonitorAvailable();
    let jaegerUrl: string | undefined = undefined;
    if (networkSpec.settings.enable_tracing) {
      switch (client.providerName) {
        case "kubernetes":
          if (networkSpec.settings.jaeger_agent)
            jaegerUrl = networkSpec.settings.jaeger_agent;
          break;
        case "podman":
          jaegerUrl = `${await client.getNodeIP("tempo")}:6831`;
          break;
      }
      if (process.env.ZOMBIE_JAEGER_URL)
        jaegerUrl = process.env.ZOMBIE_JAEGER_URL;
    }

    const spawnOpts = {
      silent: opts.silent,
      inCI: opts.inCI,
      monitorIsAvailable,
      userDefinedTypes,
      jaegerUrl,
      local_ip: networkSpec.settings.local_ip,
    };

    const firstNode = networkSpec.relaychain.nodes.shift();
    if (firstNode) {
      const nodeMultiAddress = await spawnNode(
        client,
        firstNode,
        network,
        bootnodes,
        filesToCopyToNodes,
        spawnOpts,
      );
      await sleep(2000);

      // add bootnodes to chain spec
      bootnodes.push(nodeMultiAddress);
      await addBootNodes(specs.chainSpecFullPath, bootnodes);
    }

    const promiseGenerators = networkSpec.relaychain.nodes.map((node: Node) => {
      return () =>
        spawnNode(
          client,
          node,
          network!,
          bootnodes,
          filesToCopyToNodes,
          spawnOpts,
        );
    });

    await series(promiseGenerators, opts.spawnConcurrency);

    // TODO: handle `addToBootnodes` in a diff serie.
    // for (const node of networkSpec.relaychain.nodes) {
    //   if (node.addToBootnodes) {
    //     bootnodes.push(network.getNodeByName(node.name).multiAddress);
    //     await addBootNodes(chainSpecFullPath, bootnodes);
    //   }
    // }

    new CreateLogTable({ colWidths: [120], doubleBorder: true }).pushToPrint([
      [decorators.green("All relay chain nodes spawned...")],
    ]);
    debug("\t All relay chain nodes spawned...");

    const collatorPromiseGenerators = [];
    for (const parachain of networkSpec.parachains) {
      if (!parachain.addToGenesis && parachain.registerPara) {
        // register parachain on a running network
        const basePath = `${dataDir.path}/${parachain.name}`;
        // ensure node is up.
        await nodeChecker(network.relay[0]);
        await registerParachain({
          id: parachain.id,
          wasmPath: `${basePath}/${GENESIS_WASM_FILENAME}`,
          statePath: `${basePath}/${GENESIS_STATE_FILENAME}`,
          apiUrl: network.relay[0].wsUri,
          onboardAsParachain: parachain.onboardAsParachain,
        });
      }

      if (parachain.cumulusBased) {
        const firstCollatorNode = parachain.collators.shift();
        if (firstCollatorNode) {
          const collatorMultiAddress = await spawnNode(
            client,
            firstCollatorNode,
            network,
            [],
            filesToCopyToNodes,
            spawnOpts,
            parachain,
          );
          await sleep(2000);
          // add bootnodes to chain spec
          await addBootNodes(parachain.specPath!, [collatorMultiAddress]);
        }
      }

      collatorPromiseGenerators.push(
        ...parachain.collators.map((node: Node) => {
          return () =>
            spawnNode(
              client,
              node,
              network!,
              [],
              filesToCopyToNodes,
              spawnOpts,
              parachain,
            );
        }),
      );
    }

    // launch all collator in series
    await series(collatorPromiseGenerators, opts.spawnConcurrency);

    // spawn polkadot-introspector if is enable and IFF provider is
    // podman or kubernetes
    if (
      networkSpec.settings.polkadot_introspector &&
      ["podman", "kubernetes"].includes(client.providerName)
    ) {
      const introspectorNetworkNode = await spawnIntrospector(
        client,
        network.relay[0],
        options?.inCI,
      );
      network.addNode(introspectorNetworkNode, Scope.COMPANION);
    }

    // Set `tracing_collator` config to the network if is available.
    await setTracingCollatorConfig(networkSpec, network, client);

    // sleep to give time to last node process' to start
    await sleep(2 * 1000);

    await verifyNodes(network);

    // cleanup global timeout
    network.launched = true;
    clearTimeout(timeoutTimer);
    debug(
      `\t 🚀 LAUNCH COMPLETE under namespace ${decorators.green(namespace)} 🚀`,
    );

    // clean cache before dump the info.
    network.cleanMetricsCache();
    await fs.promises.writeFile(
      `${dataDir.path}/zombie.json`,
      JSON.stringify(network),
    );

    return network;
  } catch (error: any) {
    let errDetails;
    if (
      error?.stderr?.includes(POLKADOT_NOT_FOUND) ||
      error?.stderr?.includes(PARACHAIN_NOT_FOUND)
    ) {
      errDetails = POLKADOT_NOT_FOUND_DESCRIPTION;
    }
    console.log(
      `${decorators.red("Error: ")} \t ${decorators.bright(
        error,
      )}\n\n${decorators.magenta(errDetails)}`,
    );
    if (network) {
      await network.dumpLogs();
      await network.stop();
    }
    if (cronInterval) clearInterval(cronInterval);
    process.exit(1);
  }
}
