import { decorators, getRandomPort } from "../utils";
import fs from "fs";
import chainSpecFns, { isRawSpec } from "./chainSpec";
import { getUniqueName } from "./configGenerator";
import {
  DEFAULT_COLLATOR_IMAGE,
  GENESIS_STATE_FILENAME,
  GENESIS_WASM_FILENAME,
  K8S_WAIT_UNTIL_SCRIPT_SUFIX,
  WAIT_UNTIL_SCRIPT_SUFIX,
} from "./constants";
import { decorate } from "./paras-decorators";
import { Providers } from "./providers";
import { getClient } from "./providers/client";
import { Node, Parachain, ZombieRole, fileMap } from "./types";

const debug = require("debug")("zombie::paras");

export async function generateParachainFiles(
  namespace: string,
  tmpDir: string,
  parachainFilesPath: string,
  relayChainName: string,
  parachain: Parachain,
  relayChainSpecIsRaw: boolean,
): Promise<void> {
  const [
    addAuraAuthority,
    addAuthority,
    changeGenesisConfig,
    clearAuthorities,
    readAndParseChainSpec,
    specHaveSessionsKeys,
    getNodeKey,
    addParaCustom,
    addCollatorSelection,
    writeChainSpec,
  ] = decorate(parachain.para, [
    chainSpecFns.addAuraAuthority,
    chainSpecFns.addAuthority,
    chainSpecFns.changeGenesisConfig,
    chainSpecFns.clearAuthorities,
    chainSpecFns.readAndParseChainSpec,
    chainSpecFns.specHaveSessionsKeys,
    chainSpecFns.getNodeKey,
    chainSpecFns.addParaCustom,
    chainSpecFns.addCollatorSelection,
    chainSpecFns.writeChainSpec,
  ]);
  const GENESIS_STATE_FILENAME_WITH_ID = `${GENESIS_STATE_FILENAME}-${parachain.id}`;
  const GENESIS_WASM_FILENAME_WITH_ID = `${GENESIS_WASM_FILENAME}-${parachain.id}`;

  const stateLocalFilePath = `${parachainFilesPath}/${GENESIS_STATE_FILENAME}`;
  const wasmLocalFilePath = `${parachainFilesPath}/${GENESIS_WASM_FILENAME}`;
  const client = getClient();

  const { setupChainSpec, getChainSpecRawPara } = Providers.get(
    client.providerName,
  );

  let chainSpecFullPath;
  const chainName = `${parachain.chain ? parachain.chain + "-" : ""}${
    parachain.name
  }-${relayChainName}`;
  const chainSpecFileName = `${chainName}.json`;

  const paraChainSpecFullPathPlain = `${tmpDir}/${chainName}-plain.json`;

  if (parachain.cumulusBased) {
    // need to create the parachain spec
    // file name template is [para chain-]<para name>-<relay chain>
    const relayChainSpecFullPathPlain = `${tmpDir}/${relayChainName}-plain.json`;

    // Check if the chain-spec file is provided.
    if (parachain.chainSpecPath) {
      console.log("parachain chain spec provided");
      await fs.promises.copyFile(
        parachain.chainSpecPath,
        paraChainSpecFullPathPlain,
      );
    } else {
      console.log("creating chain spec plain");
      // create or copy chain spec
      await setupChainSpec(
        namespace,
        {
          chainSpecPath: parachain.chainSpecPath,
          chainSpecCommand: `${parachain.collators[0].command} build-spec ${
            parachain.chain ? "--chain " + parachain.chain : ""
          } --disable-default-bootnode`,
          defaultImage: parachain.collators[0].image,
        },
        chainName,
        paraChainSpecFullPathPlain,
      );
    }

    chainSpecFullPath = `${tmpDir}/${chainSpecFileName}`;

    console.log(JSON.stringify({
      GENESIS_STATE_FILENAME_WITH_ID,
      GENESIS_WASM_FILENAME_WITH_ID,
      stateLocalFilePath,
      wasmLocalFilePath,
      chainSpecFullPath,
      chainName,
      chainSpecFileName,
      paraChainSpecFullPathPlain
    }))
    
    if (!(await isRawSpec(paraChainSpecFullPathPlain))) {
      console.log("isn't a raw spec")
      // fields
      const plainData = readAndParseChainSpec(paraChainSpecFullPathPlain);
      const relayChainSpec = readAndParseChainSpec(relayChainSpecFullPathPlain);
      if (plainData.para_id) plainData.para_id = parachain.id;
      if (plainData.paraId) plainData.paraId = parachain.id;
      if (plainData.relay_chain) plainData.relay_chain = relayChainSpec.id;
      if (plainData.genesis.runtime?.parachainInfo?.parachainId)
        plainData.genesis.runtime.parachainInfo.parachainId = parachain.id;

      writeChainSpec(paraChainSpecFullPathPlain, plainData);

      // make genesis overrides first.
      if (parachain.genesis) {
        console.log('changeGenesisConfig')
        await changeGenesisConfig(paraChainSpecFullPathPlain, parachain.genesis);
      }

      // clear auths
      await clearAuthorities(paraChainSpecFullPathPlain);

      // Chain spec customization logic
      const addToSession = async (node: Node) => {
        console.log('addToSession')
        const key = getNodeKey(node, false);
        await addAuthority(paraChainSpecFullPathPlain, node, key);
      };

      const addToAura = async (node: Node) => {
        console.log('addToAura')
        await addAuraAuthority(
          paraChainSpecFullPathPlain,
          node.name,
          node.accounts!,
        );
      };

      const addAuthFn = specHaveSessionsKeys(plainData)
        ? addToSession
        : addToAura;

      for (const node of parachain.collators) {
        if (node.validator) {
          console.log('addAuthFn')
          await addAuthFn(node);
          console.log('addCollatorSelection')
          await addCollatorSelection(paraChainSpecFullPathPlain, node);
          console.log('addParaCustom')
          await addParaCustom(paraChainSpecFullPathPlain, node);
        }
      }

      debug("creating chain spec raw");
      // ensure needed file
      if (parachain.chain)
        fs.copyFileSync(
          paraChainSpecFullPathPlain,
          `${tmpDir}/${parachain.chain}-${parachain.name}-plain.json`,
        );
      // generate the raw chain spec
      await getChainSpecRawPara(
        namespace,
        parachain.collators[0].image,
        `${parachain.chain ? parachain.chain + "-" : ""}${
          parachain.name
        }-${relayChainName}`,
        parachain.collators[0].command!,
        chainSpecFullPath,
      );
    } else {
      console.log(
        `\n\t\t 🚧 ${decorators.yellow(
          `Chain Spec for paraId ${parachain.id} was set to a file in raw format, can't customize.`,
        )} 🚧`,
      );
      await fs.promises.copyFile(paraChainSpecFullPathPlain, chainSpecFullPath);
    }

    try {
      // ensure the correct para_id
      const paraSpecRaw = readAndParseChainSpec(chainSpecFullPath);
      if (paraSpecRaw.para_id) paraSpecRaw.para_id = parachain.id;
      if (paraSpecRaw.paraId) paraSpecRaw.paraId = parachain.id;
      writeChainSpec(chainSpecFullPath, paraSpecRaw);
    } catch (e: any) {
      if (e.code !== "ERR_FS_FILE_TOO_LARGE") throw e;

      // can't customize para_id
      console.log(
        `\n\t\t 🚧 ${decorators.yellow(
          `Chain Spec file ${chainSpecFullPath} is TOO LARGE to customize (more than 2G).`,
        )} 🚧`,
      );
    }

    // add spec file to copy to all collators.
    parachain.specPath = chainSpecFullPath;
  }

  // state and wasm files are only needed:
  // IFF the relaychain is NOT RAW or
  // IFF the relaychain is raw and addToGenesis is false for the parachain
  const stateAndWasmAreNeeded = !(
    relayChainSpecIsRaw && parachain.addToGenesis
  );
  // check if we need to create files
  if (
    stateAndWasmAreNeeded &&
    (parachain.genesisStateGenerator || parachain.genesisWasmGenerator)
  ) {
    const filesToCopyToNodes: fileMap[] = [];
    if (parachain.cumulusBased && chainSpecFullPath)
      filesToCopyToNodes.push({
        localFilePath: chainSpecFullPath,
        remoteFilePath: `${client.remoteDir}/${chainSpecFileName}`,
      });

    const commands = [];
    if (parachain.genesisStateGenerator) {
      let genesisStateGenerator = parachain.genesisStateGenerator.replace(
        "{{CLIENT_REMOTE_DIR}}",
        client.remoteDir as string,
      );
      // cumulus
      if (parachain.cumulusBased) {
        const chainSpecPathInNode =
          client.providerName === "native"
            ? chainSpecFullPath
            : `${client.remoteDir}/${chainSpecFileName}`;

        genesisStateGenerator = genesisStateGenerator.replace(
          " > ",
          ` --chain ${chainSpecPathInNode} > `,
        );
      }
      commands.push(`${genesisStateGenerator}-${parachain.id}`);
    }
    if (parachain.genesisWasmGenerator) {
      let genesisWasmGenerator = parachain.genesisWasmGenerator.replace(
        "{{CLIENT_REMOTE_DIR}}",
        client.remoteDir as string,
      );
      // cumulus
      if (parachain.collators[0].zombieRole === ZombieRole.CumulusCollator) {
        const chainSpecPathInNode =
          client.providerName === "native"
            ? chainSpecFullPath
            : `${client.remoteDir}/${chainSpecFileName}`;

        genesisWasmGenerator = genesisWasmGenerator.replace(
          " > ",
          ` --chain ${chainSpecPathInNode} > `,
        );
      }
      commands.push(`${genesisWasmGenerator}-${parachain.id}`);
    }

    // Native provider doesn't need to wait
    if (client.providerName == "kubernetes")
      commands.push(K8S_WAIT_UNTIL_SCRIPT_SUFIX);
    else if (client.providerName == "podman")
      commands.push(WAIT_UNTIL_SCRIPT_SUFIX);

    const node: Node = {
      name: getUniqueName("temp-collator"),
      validator: false,
      invulnerable: false,
      image: parachain.collators[0].image || DEFAULT_COLLATOR_IMAGE,
      fullCommand: commands.join(" && "),
      chain: relayChainName,
      bootnodes: [],
      args: [],
      env: [],
      telemetryUrl: "",
      overrides: [],
      zombieRole: ZombieRole.Temp,
      p2pPort: await getRandomPort(),
      wsPort: await getRandomPort(),
      rpcPort: await getRandomPort(),
      prometheusPort: await getRandomPort(),
    };

    const provider = Providers.get(client.providerName);
    const podDef = await provider.genNodeDef(namespace, node);
    const podName = podDef.metadata.name;

    await client.spawnFromDef(podDef, filesToCopyToNodes);

    if (parachain.genesisStateGenerator) {
      await client.copyFileFromPod(
        podDef.metadata.name,
        `${client.remoteDir}/${GENESIS_STATE_FILENAME_WITH_ID}`,
        stateLocalFilePath,
      );
    }

    if (parachain.genesisWasmGenerator) {
      await client.copyFileFromPod(
        podDef.metadata.name,
        `${client.remoteDir}/${GENESIS_WASM_FILENAME_WITH_ID}`,
        wasmLocalFilePath,
      );
    }

    await client.putLocalMagicFile(podName, podName);
  }

  if (parachain.genesisStatePath) {
    fs.copyFileSync(parachain.genesisStatePath, stateLocalFilePath);
  }

  if (parachain.genesisWasmPath) {
    fs.copyFileSync(parachain.genesisWasmPath, wasmLocalFilePath);
  }

  // add paths to para files
  parachain.wasmPath = wasmLocalFilePath;
  parachain.statePath = stateLocalFilePath;

  return;
}
