require('dotenv').config();
const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { u8aToHex } = require('@polkadot/util');
const typedefs = require('@phala/typedefs').khalaDev;
const fs = require('fs');

async function main() {
    const file = fs.readFileSync('./parakeys.json', { encoding: 'utf-8' });
    const operations = JSON.parse(file);
    const {names, formats, mnemonic} = operations;
    await cryptoWaitReady();
    const sr_keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    const ed_keyring = new Keyring({ type: 'ed25519', ss58Format: 42 });
    const ec_keyring = new Keyring({ type: 'ecdsa', ss58Format: 42 });
    
    for (let i=0; i < names.length; i++) {
        const { port, name } = names[i];
        const endpoint = `ws://localhost:${port}`;
        const wsProvider = new WsProvider(endpoint);
        const api = await ApiPromise.create({ provider: wsProvider, types: typedefs });
        for (let j=0; j < formats.length; j++) {
            const { suffix, keyType, format } = formats[j];
            if (format === 'sr25519') {
                const uri = `${mnemonic}//${name}//${suffix}`;
                const keyring = sr_keyring.addFromUri(uri);
                const pubkey = u8aToHex(keyring.publicKey);
                const params = [keyType, uri, pubkey];
                await api.rpc.author.insertKey(keyType, uri, pubkey);
            }
        }
    }
}

main().catch(console.error).finally(() => {process.exit()});
