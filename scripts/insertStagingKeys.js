require('dotenv').config();
const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { u8aToHex } = require('@polkadot/util');
const typedefs = require('@phala/typedefs').khalaDev;
const fs = require('fs');

async function main() {
    const file = fs.readFileSync('./staging-keys.json', { encoding: 'utf-8' });
    const operations = JSON.parse(file);
    const {names, keys, mnemonic} = operations;
    await cryptoWaitReady();
    const sr_keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    const ed_keyring = new Keyring({ type: 'ed25519', ss58Format: 42 });
    const ec_keyring = new Keyring({ type: 'ecdsa', ss58Format: 42 });
    
    for (let i=0; i < names.length; i++) {
        const { port, name } = names[i];
        const endpoint = `ws://localhost:${port}`;
        const wsProvider = new WsProvider(endpoint);
        const api = await ApiPromise.create({ provider: wsProvider, types: typedefs });
        for (let j=0; j < keys.length; j++) {
            const { suffix, short, format } = keys[j];
            if (format === 'sr25519') {
                const uri = `${mnemonic}//${name}//${suffix}`;
                const keyring = sr_keyring.addFromUri(uri);
                const pubkey = u8aToHex(keyring.publicKey);
                console.log(pubkey);
                console.log(uri);
                const params = [short, uri, pubkey];
                console.log(params);
                await api.rpc.author.insertKey(short, uri, pubkey);
            }
            if (format === 'ed25519') {
                const uri = `${mnemonic}//${name}//${suffix}`;
                const keyring = ed_keyring.addFromUri(uri);
                const pubkey = u8aToHex(keyring.publicKey);
                console.log(pubkey);
                console.log(uri);
                const params = [short, uri, pubkey];
                console.log(params);

                await api.rpc.author.insertKey(short, uri, pubkey);
            }
            if (format === 'ecdsa') {
                const uri = `${mnemonic}//${name}//${suffix}`;
                const keyring = ec_keyring.addFromUri(uri);
                const pubkey = u8aToHex(keyring.publicKey);
                console.log(pubkey);
                console.log(uri);
                const params = [short, uri, pubkey];
                console.log(params);

                await api.rpc.author.insertKey(short, uri, pubkey);
            }
        }
    }
}

main().catch(console.error).finally(() => {process.exit()});
