import { Network, start } from "../../orchestrator";
import { LaunchConfig } from "../../orchestrator/types";
import {
  decorators,
  getCredsFilePath,
  readNetworkConfig,
} from "../../utils";
import fs from "fs";
import { resolve } from "path";
import {
  AVAILABLE_PROVIDERS,
  DEFAULT_GLOBAL_TIMEOUT,
  DEFAULT_PROVIDER,
} from "../constants";

/**
 * Spawn - spawns ephemeral networks, providing a simple but poweful cli that allow you to declare
 * the desired network in toml or json format.
 * Read more here: https://paritytech.github.io/zombienet/cli/spawn.html
 * @param configFile: config file, supported both json and toml formats
 * @param credsFile: Credentials file name or path> to use (Only> with kubernetes provider), we look
 *  in the current directory or in $HOME/.kube/ if a filename is passed.
 * @param _opts
 *
 * @returns Network
 */

export async function spawn(
  configFile: string,
  credsFile: string | undefined,
  cmdOpts: any,
  program: any,
  setGlobalNetwork: (network: Network) => void,
): Promise<void> {
  // {"configFile":"./chain_specs/my-network.json","cmdOpts":{}}
  const opts = { ...program.parent.opts(), ...cmdOpts };
  const dir = `${process.env.DATA_DIR}` || `/tmp`;
  const force = opts.force || false;
  const monitor = opts.monitor || false;
  // By default spawn pods/process in batches of 4,
  // since this shouldn't be a bottleneck in most of the cases,
  // but also can be set with the `-c` flag.
  const spawnConcurrency = opts.spawnConcurrency || 4;
  const configPath = resolve(process.cwd(), configFile);
  if (!fs.existsSync(configPath)) {
    console.error(
      `${decorators.reverse(
        decorators.red(`  ⚠ Config file does not exist: ${configPath}`),
      )}`,
    );
    process.exit();
  }

  const filePath = resolve(configFile);
  const config: LaunchConfig = readNetworkConfig(filePath);

  // set default provider and timeout if not provided
  if (!config.settings) {
    config.settings = {
      provider: DEFAULT_PROVIDER,
      timeout: DEFAULT_GLOBAL_TIMEOUT,
    };
  } else {
    if (!config.settings.provider) config.settings.provider = DEFAULT_PROVIDER;
    if (!config.settings.timeout)
      config.settings.timeout = DEFAULT_GLOBAL_TIMEOUT;
  }

  // if a provider is passed, let just use it.
  if (opts.provider && AVAILABLE_PROVIDERS.includes(opts.provider)) {
    config.settings.provider = opts.provider;
  }

  let creds = "";

  const inCI = process.env.RUN_IN_CONTAINER === "1";
  const options = {
    monitor,
    spawnConcurrency,
    dir,
    force,
    inCI,
    silent: false,
    setGlobalNetwork,
  };
  await start(creds, config, options);
  // network.showNetworkInfo(config.settings?.provider);
  // keep the process running
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setInterval(() => {}, 1000);
}
