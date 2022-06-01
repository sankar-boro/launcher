// USAGE
// NUM_VALIDATORS=3 NUM_TECH_COMMITTEE=0 ENDOWMENT='' MNEMONIC='xxx' OUT=../../node/res/khala_local_genesis_info.json node gen_khala_genesis.js

require('dotenv').config();

const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady, encodeAddress } = require('@polkadot/util-crypto');
const { u8aToHex } = require('@polkadot/util');
const fs = require('fs');

const genPublicKeys = (keyrings, names, keys, mnemonic) => {
    const { sr_keyring, ed_keyring, ec_keyring } = keyrings;
    const allPublicKeys = [];
    for (let currentNameIndex = 0; currentNameIndex < names.length; currentNameIndex++) {
        const { name } = names[currentNameIndex];
        //
        const thisPublicKey = [];
        //
        for (let currentKeyIndex = 0; currentKeyIndex < keys.length; currentKeyIndex++) {
            const { suffix, format } = keys[currentKeyIndex];
            const uri = `${mnemonic}//${name}//${suffix}`;
            //
            if (format === 'sr25519'){ 
                const sr = sr_keyring.addFromUri(uri);
                thisPublicKey.push(u8aToHex(sr.publicKey));
            }
            //
            if (format === 'ed25519'){ 
                const ed = ed_keyring.addFromUri(uri);
                thisPublicKey.push(u8aToHex(ed.publicKey));
            }
            //
            if (format === 'ecdsa'){ 
                const ec = ec_keyring.addFromUri(uri);
                thisPublicKey.push(u8aToHex(ec.publicKey));
            }
        }
        //
        allPublicKeys.push(thisPublicKey);
    }
    console.log(allPublicKeys);
}

const genAddress = (keyrings, names, keys, mnemonic) => {
    const { sr_keyring, ed_keyring, ec_keyring } = keyrings;
    const allUris = [];
    const allAddress = [];

    for (let currentNameIndex = 0; currentNameIndex < names.length; currentNameIndex++) {
        const { name } = names[currentNameIndex];
        //
        const thisUri = [];
        const thisAddress = [];
        //
        for (let currentKeyIndex = 0; currentKeyIndex < keys.length; currentKeyIndex++) {
            const { suffix, format } = keys[currentKeyIndex];
            const uri = `${mnemonic}//${name}//${suffix}`;
            thisUri.push(uri);
            //
            if (format === 'sr25519'){ 
                const sr = sr_keyring.addFromUri(uri);
                thisAddress.push(sr.address);
            }
            //
            if (format === 'ed25519'){ 
                const ed = ed_keyring.addFromUri(uri);
                thisAddress.push(ed.address);
            }
            //
            if (format === 'ecdsa'){ 
                const ec = ec_keyring.addFromUri(uri);
                thisAddress.push(encodeAddress(ec.publicKey));
            }
        }
        //
        allUris.push(thisUri);
        allAddress.push(thisAddress);
    }
    const genesis = { initialAuthorities: allAddress };
    console.log(genesis)
}

async function main() {
    const file = fs.readFileSync('./relaykeys.json', { encoding: 'utf-8' });
    const operations = JSON.parse(file);
    const {names, keys, mnemonic} = operations;
    await cryptoWaitReady();
    const sr_keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    const ed_keyring = new Keyring({ type: 'ed25519', ss58Format: 42 });
    const ec_keyring = new Keyring({ type: 'ecdsa', ss58Format: 42 });
    const address = { sr_keyring, ed_keyring, ec_keyring };
    // genAddress(address, names, keys, mnemonic);
    genPublicKeys(address, names, keys, mnemonic);
}

main().catch(console.error).finally(() => {process.exit()});
