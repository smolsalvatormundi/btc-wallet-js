#!/usr/bin/env node

// BTC Wallet CLI - Taproot Ready
// Uses bitcoinjs-lib 6.1.6 with fixes

const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Monkey-patch toXOnly to return Buffer (required for v6.1.6)
const originalToXOnly = require("bitcoinjs-lib/src/psbt/bip371.js").toXOnly;
require("bitcoinjs-lib/src/psbt/bip371.js").toXOnly = (pubkey) => {
  const result = originalToXOnly(pubkey);
  return Buffer.from(result);
};

// Initialize ECC FIRST - before any bitcoin.* calls
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const network = bitcoin.networks.bitcoin;
const testnet = bitcoin.networks.testnet;
const regtest = bitcoin.networks.regtest;

let currentNetwork = network;
let wallet = null;
let derivedKey = null; // For BIP86 derived key

// Helper: toXOnly
const toXOnly = (pubkey) => {
  if (pubkey.length === 33) return Buffer.from(pubkey.slice(1));
  if (pubkey.length === 65) return Buffer.from(pubkey.slice(1, 33));
  return Buffer.from(pubkey);
};

// BIP86 derivation using @scure/bip32
async function deriveBIP86Key(mnemonic, isTestnet = false) {
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  
  const path = isTestnet ? "m/86'/1'/0'/0/0" : "m/86'/0'/0'/0/0";
  const key = root.derive(path);
  
  return {
    privateKey: Buffer.from(key.privateKey),
    publicKey: Buffer.from(key.publicKey),
    xOnly: Buffer.from(key.publicKey.slice(1))
  };
}

// Helper: Load or create wallet (async for BIP86)
async function loadWallet() {
  const walletPath = path.join(process.env.HOME || "/root", ".config", "btc-wallet", "wallet.json");
  if (fs.existsSync(walletPath)) {
    wallet = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    // Handle both "testnet" boolean and "network": "testnet" string
    wallet.testnet = wallet.testnet || wallet.network === "testnet";
    currentNetwork = wallet.testnet ? testnet : network;
    
    // If we have a mnemonic, derive BIP86 key
    if (wallet.mnemonic) {
      derivedKey = await deriveBIP86Key(wallet.mnemonic, wallet.testnet);
    }
  }
}

function saveWallet() {
  const walletDir = path.join(process.env.HOME || "/root", ".config", "btc-wallet");
  if (!fs.existsSync(walletDir)) fs.mkdirSync(walletDir, { recursive: true });
  const walletPath = path.join(walletDir, "wallet.json");
  fs.writeFileSync(walletPath, JSON.stringify(wallet, null, 2));
}

// Helper: Get address from key
function getAddress(keyPair) {
  const internalPubkey = toXOnly(keyPair.publicKey);
  
  // Use internalPubkey: for P2TR creation (BIP86)
  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: internalPubkey,
    network: currentNetwork,
  });
  
  return p2tr.address;
}

// Generate new wallet
function newWallet(testnetFlag = false) {
  currentNetwork = testnetFlag ? testnet : network;
  
  const keyPair = ECPair.makeRandom({ network: currentNetwork });
  const privateKey = keyPair.toWIF();
  const address = getAddress(keyPair);
  
  wallet = {
    privateKey,
    address,
    testnet: testnetFlag,
    created: new Date().toISOString()
  };
  
  saveWallet();
  console.log(`✅ Wallet created!`);
  console.log(`   Address: ${address}`);
  if (testnetFlag) console.log(`   (Testnet)`);
}

// Import wallet from WIF
function importWallet(wif, testnetFlag = false) {
  currentNetwork = testnetFlag ? testnet : network;
  
  let keyPair;
  try {
    keyPair = ECPair.fromWIF(wif, currentNetwork);
  } catch (e) {
    // Try with any network if specific fails
    keyPair = ECPair.fromWIF(wif);
  }
  const address = getAddress(keyPair);
  
  wallet = {
    privateKey: wif,
    address,
    testnet: testnetFlag,
    imported: new Date().toISOString()
  };
  
  saveWallet();
  console.log(`✅ Wallet imported!`);
  console.log(`   Address: ${address}`);
  if (testnetFlag) console.log(`   (Testnet)`);
}

// Get balance from mempool.space
async function getBalance() {
  if (!wallet) {
    console.log("❌ No wallet found. Run 'new' or 'import' first.");
    return;
  }
  
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  try {
    const response = await axios.get(`${baseUrl}/address/${wallet.address}`);
    const data = response.data;
    
    console.log(`💰 Balance: ${data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum} sats`);
    console.log(`   Confirmed: ${data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum} sats`);
    console.log(`   Unconfirmed: ${data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum} sats`);
  } catch (error) {
    console.log(`❌ Error fetching balance: ${error.message}`);
  }
}

// Get UTXOs
async function getUtxos() {
  if (!wallet) {
    console.log("❌ No wallet found.");
    return;
  }
  
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  try {
    const response = await axios.get(`${baseUrl}/address/${wallet.address}/utxo`);
    const utxos = response.data;
    
    if (utxos.length === 0) {
      console.log("No UTXOs found.");
      return;
    }
    
    console.log(`📋 UTXOs (${utxos.length}):`);
    for (const utxo of utxos) {
      console.log(`   ${utxo.txid}:${utxo.vout} - ${utxo.value} sats`);
    }
    return utxos;
  } catch (error) {
    console.log(`❌ Error fetching UTXOs: ${error.message}`);
  }
}

// Create PSBT
async function createPsbt(toAddress, amountSats) {
  if (!wallet) {
    console.log("❌ No wallet found.");
    return null;
  }
  
  const utxos = await getUtxos();
  if (!utxos || utxos.length === 0) {
    console.log("❌ No UTXOs available.");
    return null;
  }
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, currentNetwork);
  const changeAddress = wallet.address;
  
  const internalPubkey = toXOnly(keyPair.publicKey);
  
  const psbt = new bitcoin.Psbt({ network: currentNetwork });
  
  // Add inputs with tapInternalKey
  for (const utxo of utxos) {
    const txResponse = await axios.get(
      `${wallet.testnet ? "https://mempool.space/testnet/api" : "https://mempool.space/api"}/tx/${utxo.txid}`
    );
    const tx = txResponse.data;
    
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(tx.vout[utxo.vout].scriptpubkey, "hex"),
        value: tx.vout[utxo.vout].value,
      },
      tapInternalKey: internalPubkey,
    });
  }
  
  // Add outputs
  psbt.addOutput({
    address: toAddress,
    value: amountSats,
  });
  
  // Change output
  const totalIn = utxos.reduce((sum, u) => sum + u.value, 0);
  const fee = 1000;
  const change = totalIn - amountSats - fee;
  
  psbt.addOutput({
    address: changeAddress,
    value: change,
  });
  
  return psbt;
}

// Sign PSBT
function signPsbt(psbt) {
  if (!wallet) {
    console.log("❌ No wallet found.");
    return null;
  }
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, currentNetwork);
  
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    psbt.signInput(i, keyPair);
  }
  
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    psbt.finalizeInput(i);
  }
  
  return psbt;
}

// Broadcast PSBT
async function broadcast(psbt) {
  if (!wallet) {
    console.log("❌ No wallet found.");
    return;
  }
  
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();
  
  try {
    const response = await axios.post(`${baseUrl}/tx`, txHex);
    const txid = response.data;
    console.log(`✅ Broadcast successful!`);
    console.log(`   TXID: ${txid}`);
    console.log(`   ${wallet.testnet ? "https://mempool.space/testnet/tx/" : "https://mempool.space/tx/"}${txid}`);
  } catch (error) {
    console.log(`❌ Broadcast failed: ${error.response?.data || error.message}`);
  }
}

// Send BTC
async function send(toAddress, amountSats) {
  console.log(`📤 Creating transaction to ${toAddress} for ${amountSats} sats...`);
  
  const psbt = await createPsbt(toAddress, amountSats);
  if (!psbt) return;
  
  console.log(`✍️  Signing...`);
  const signedPsbt = signPsbt(psbt);
  if (!signedPsbt) return;
  
  console.log(`📡 Broadcasting...`);
  await broadcast(signedPsbt);
}

// Show wallet info
function info() {
  if (!wallet) {
    console.log("❌ No wallet found.");
    return;
  }
  
  console.log(`� wallet info:`);
  console.log(`   Address: ${wallet.address}`);
  console.log(`   Network: ${wallet.testnet ? "testnet" : "mainnet"}`);
  if (wallet.created) console.log(`   Created: ${wallet.created}`);
  if (wallet.imported) console.log(`   Imported: ${wallet.imported}`);
}

// Derive addresses from different paths (diagnostics)
function derivePaths() {
  if (!wallet) {
    console.log("No wallet found.");
    return;
  }
  
  if (!wallet.mnemonic) {
    console.log("Cannot derive paths from WIF. Need mnemonic.");
    return;
  }
  
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  const { payments, networks } = require('bitcoinjs-lib');
  
  const seed = mnemonicToSeedSync(wallet.mnemonic);
  const network = wallet.testnet ? networks.testnet : networks.bitcoin;
  const root = HDKey.fromMasterSeed(seed);
  
  const paths = wallet.testnet ? [
    "m/86'/1'/0'/0/0", // BIP86 Taproot
    "m/84'/1'/0'/0/0", // BIP84 native segwit
    "m/44'/1'/0'/0/0", // BIP44 legacy
  ] : [
    "m/86'/0'/0'/0/0", // BIP86 Taproot
    "m/84'/0'/0'/0/0", // BIP84 native segwit
    "m/44'/0'/0'/0/0", // BIP44 legacy
  ];
  
  console.log("\nAddresses at different derivation paths:\n");
  for (const path of paths) {
    try {
      const child = root.derive(path);
      const xOnly = Buffer.from(child.publicKey.slice(1));
      const p2tr = payments.p2tr({ internalPubkey: xOnly, network });
      console.log("   " + path);
      console.log("      " + p2tr.address + "\n");
    } catch (e) {
      console.log("   " + path + ": Error - " + e.message);
    }
  }
}

// CLI
const args = process.argv.slice(2);
const testnetIdx = args.indexOf("--testnet");
const testnetFlag = testnetIdx !== -1;

if (testnetIdx !== -1) {
  args.splice(testnetIdx, 1);
}

const command = args[0];

switch (command) {
  case "new":
    newWallet(testnetFlag);
    break;
  
  case "import":
    if (!args[1]) {
      console.log("Usage: import <wif>");
    } else {
      importWallet(args[1], testnetFlag);
    }
    break;
  
  case "address":
    loadWallet();
    if (wallet) {
      console.log(wallet.address);
    } else {
      console.log("❌ No wallet. Run 'new' first.");
    }
    break;
  
  case "balance":
    loadWallet();
    getBalance();
    break;
  
  case "utxos":
    loadWallet();
    getUtxos();
    break;
  
  case "send":
    loadWallet();
    if (!args[1] || !args[2]) {
      console.log("Usage: send <address> <amount_in_sats>");
    } else {
      send(args[1], parseInt(args[2]));
    }
    break;
  
  case "create-psbt":
    loadWallet();
    if (!args[1] || !args[2]) {
      console.log("Usage: create-psbt <address> <amount_in_sats>");
    } else {
      createPsbt(args[1], parseInt(args[2])).then(psbt => {
        if (psbt) {
          const psbtBase64 = psbt.toBase64();
          console.log(`✅ PSBT created:`);
          console.log(psbtBase64);
        }
      });
    }
    break;
  
  case "sign-psbt":
    loadWallet();
    if (!args[1]) {
      console.log("Usage: sign-psbt <psbt_file>");
    } else {
      const psbtBase64 = fs.readFileSync(args[1], "utf8");
      const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
      const signed = signPsbt(psbt);
      if (signed) {
        const outFile = args[1].replace(".psbt", "-signed.psbt");
        fs.writeFileSync(outFile, signed.toBase64());
        console.log(`✅ Signed PSBT saved to: ${outFile}`);
      }
    }
    break;
  
  case "broadcast":
    if (!args[1]) {
      console.log("Usage: broadcast <psbt_file>");
    } else {
      loadWallet();
      const psbtBase64 = fs.readFileSync(args[1], "utf8");
      const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
      broadcast(psbt);
    }
    break;
  
  case "info":
    loadWallet();
    info();
    break;
  
  case "derive":
    loadWallet();
    derivePaths();
    break;
  
  case "clear":
    const walletPath = path.join(process.env.HOME || "/root", ".config", "btc-wallet", "wallet.json");
    if (fs.existsSync(walletPath)) {
      fs.unlinkSync(walletPath);
      console.log("✅ Wallet cleared.");
    } else {
      console.log("No wallet to clear.");
    }
    break;
  
  default:
    console.log(`
🔴 BTC Wallet CLI (JS - Taproot Fixed!)

Usage:
  btc-wallet new                    - Generate new wallet
  btc-wallet import <wif>           - Import from WIF
  btc-wallet address                 - Show address
  btc-wallet balance                - Show balance
  btc-wallet utxos                  - List UTXOs
  btc-wallet send <addr> <sats>    - Send BTC
  btc-wallet create-psbt <addr> <sats> - Create PSBT
  btc-wallet sign-psbt <file>       - Sign PSBT
  btc-wallet broadcast <file>       - Broadcast PSBT
  btc-wallet info                   - Wallet info
  btc-wallet clear                  - Delete wallet

Options:
  --testnet                         - Use testnet

Key fixes:
  ✅ initEccLib called FIRST
  ✅ toXOnly() used (not .slice(1))
  ✅ internalPubkey: for P2TR creation (BIP86)
  ✅ tapInternalKey in PSBT input
  ✅ Monkey-patched toXOnly for Buffer
`);
}
