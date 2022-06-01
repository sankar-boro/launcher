// USAGE:
//   ENDPOINT=ws://127.0.0.1:9944 DRY_RUN=0 node insert_session_key.js

require('dotenv').config();

const fs = require('fs');
const { ApiPromise, Keyring, WsProvider } = require('@polkadot/api');
const { u8aToHex, stringToHex } = require('@polkadot/util');
const typedefs = require('@phala/typedefs').khalaDev;

const KEY_FILE = './para.keys.json';

async function insertKey(api, sUri, keyType, keyringType) {
    let fullSUri = sUri;
    if (keyType && keyType !== "") {
        fullSUri += "//" + keyType;
    }
    const keyring = new Keyring({ type: keyringType }).addFromUri(fullSUri);

    const pubkey = u8aToHex(keyring.publicKey);
    await api.rpc.author.insertKey(keyType, fullSUri, pubkey);
    const inserted = (await api.rpc.author.hasKey(pubkey, keyType)).toJSON();

    if (inserted) {
        console.log(`Set "${keyType}" successful, public key "${pubkey}"`)
    } else {
        console.log(`Set "${keyType}" failed, public key "${pubkey}"`)
        return;
    }

    const encodedKeyType = stringToHex(keyType.split('').reverse().join(''));
    const owner = await api.query.session.keyOwner([encodedKeyType, pubkey]);
    if (!owner.isSome) {
        console.warn(`Session key not found on-chain: ${keyType}-${pubkey}`);
    }

    return inserted;
}

async function main () {

    const file = fs.readFileSync(KEY_FILE, { encoding: 'utf-8' });
    const operations = JSON.parse(file);
    for (const {endpoint, keys} of operations) {
        const wsProvider = new WsProvider(endpoint);
        const api = await ApiPromise.create({ provider: wsProvider, types: typedefs });

        console.log(`Connected to "${endpoint}"`);
        for (const {sUri, keyType, keyringType} of keys) {
            await insertKey(api, sUri, keyType, keyringType);
        }
    }
}

main().catch(console.error).finally(() => process.exit());
