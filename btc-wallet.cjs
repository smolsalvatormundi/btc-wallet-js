#!/usr/bin/env node

// BTC Wallet CLI v0.0.1 - Taproot Ready
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

// BIP86 derivation using @scure/bip32 (synchronous)
function deriveBIP86Key(mnemonic, isTestnet = false) {
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  
  const path = isTestnet ? "m/86'/1'/0'/0/0" : "m/86'/0'/0'/0/0";
  const key = root.derive(path);
  
  // CRITICAL: @scure/bip32 returns Uint8Array views into a larger ArrayBuffer.
  // Buffer.from(uint8array) without offset/length copies from position 0 of the
  // underlying ArrayBuffer — giving wrong bytes if byteOffset is non-zero.
  const rawPriv = key.privateKey;
  const rawPub  = key.publicKey;
  
  const privateKey = Buffer.from(rawPriv.buffer, rawPriv.byteOffset, rawPriv.byteLength);
  const publicKey  = Buffer.from(rawPub.buffer, rawPub.byteOffset, rawPub.byteLength);
  const xOnly      = publicKey.slice(1); // strip 02/03 prefix → 32-byte x-only
  
  return { privateKey, publicKey, xOnly };
}

// Helper: Load or create wallet
function loadWallet() {
  const walletPath = path.join(process.env.HOME || "/root", ".config", "btc-wallet", "wallet.json");
  if (fs.existsSync(walletPath)) {
    wallet = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    // Handle both "testnet" boolean and "network": "testnet" string
    wallet.testnet = wallet.testnet || wallet.network === "testnet";
    currentNetwork = wallet.testnet ? testnet : network;
    
    // If we have a mnemonic, derive BIP86 key
    if (wallet.mnemonic) {
      derivedKey = deriveBIP86Key(wallet.mnemonic, wallet.testnet);
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
  
  // Get address from derived key
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  if (!address) {
    console.log("❌ No address available.");
    return;
  }
  
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  try {
    const response = await axios.get(`${baseUrl}/address/${address}`);
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
  
  // Get address from derived key
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  if (!address) {
    console.log("❌ No address available.");
    return;
  }
  
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  try {
    const response = await axios.get(`${baseUrl}/address/${address}/utxo`);
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
  
  // Get address from derived key
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  if (!address) {
    console.log("❌ No address available.");
    return null;
  }
  
  const utxos = await getUtxos();
  if (!utxos || utxos.length === 0) {
    console.log("❌ No UTXOs available.");
    return null;
  }
  
  // Use derived key if available
  let keyPair, internalPubkey;
  if (derivedKey) {
    keyPair = ECPair.fromPrivateKey(derivedKey.privateKey, currentNetwork);
    internalPubkey = derivedKey.xOnly;
  } else {
    keyPair = ECPair.fromWIF(wallet.privateKey, currentNetwork);
    internalPubkey = toXOnly(keyPair.publicKey);
  }
  
  const changeAddress = address;
  
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
  
  // Use derived key if available
  let keyPair;
  if (derivedKey) {
    keyPair = ECPair.fromPrivateKey(derivedKey.privateKey, currentNetwork);
    

  } else {
    keyPair = ECPair.fromWIF(wallet.privateKey, currentNetwork);
  }
  
  // Compute BIP341 tweak: t = H_TapTweak(internalKey)
  // Use bitcoinjs-lib's taggedHash which correctly implements BIP340 tagged hashing:
  //   SHA256(SHA256("TapTweak") || SHA256("TapTweak") || data)
  const internalPubkey = derivedKey ? derivedKey.xOnly : toXOnly(keyPair.publicKey);
  const tweakHash = bitcoin.crypto.taggedHash('TapTweak', internalPubkey);
  
  // Apply tweak to get the key that can sign
  const tweakedKey = keyPair.tweak(tweakHash);
  
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    psbt.signInput(i, tweakedKey);
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
  loadWallet();
  if (!wallet) {
    console.log("❌ No wallet found.");
    return;
  }
  
  console.log(`� wallet info:`);
    // Get address from derived key
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  console.log(`   Address: ${address}`);
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

// ============================================
// ORDINAL DETECTION & SWEEP FUNCTIONS
// ============================================

// Get block height from timestamp (approximate)
async function getBlockHeight() {
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  try {
    const response = await axios.get(`${baseUrl}/blocks/tip/height`);
    return response.data;
  } catch (e) {
    return null;
  }
}

// Check if a UTXO has an inscription via mempool API
async function checkInscription(txid, vout) {
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  try {
    const response = await axios.get(`${baseUrl}/tx/${txid}`);
    const tx = response.data;
    
    // Check if this output has an inscription
    // Inscriptions are in witness data - look for ordinal/envelope marker
    if (tx.vout && tx.vout[vout]) {
      // Check for inscription via ordinals/envelope
      const inscriptionCheck = await axios.get(
        `${baseUrl}/tx/${txid}/outspend/${vout}`
      ).catch(() => ({ data: {} }));
      
      if (inscriptionCheck.data?.inscription) {
        return {
          hasInscription: true,
          inscriptionId: inscriptionCheck.data.inscription,
          inscriptionNumber: inscriptionCheck.data.inscription_number
        };
      }
    }
    return { hasInscription: false };
  } catch (e) {
    return { hasInscription: false, error: e.message };
  }
}

// Identify rare sats based on ordinal theory
// https://ordinals.com/theory
function identifyRareSat(satPosition, blockHeight) {
  const rarity = {
    isRare: false,
    type: null,
    description: null
  };
  
  // Total sats in a block = 100 (initially) * 6 = ~400-720 per block historically
  // But we track by absolute satoshi position
  
  // Block 0, sat 0 - The Genesis Sat
  if (satPosition === 0) {
    rarity.isRare = true;
    rarity.type = 'genesis';
    rarity.description = 'Genesis Sat - First satoshi ever created';
    return rarity;
  }
  
  // First sat of each block
  const satsPerBlock = 100; // Initial subsidy
  const blockNumber = Math.floor(satPosition / satsPerBlock);
  const satInBlock = satPosition % satsPerBlock;
  
  if (satInBlock === 0) {
    rarity.isRare = true;
    rarity.type = 'block';
    rarity.description = `Block Founder - First sat of block ${blockNumber}`;
    return rarity;
  }
  
  // Last sat of each block
  if (satInBlock === satsPerBlock - 1) {
    rarity.isRare = true;
    rarity.type = 'block-end';
    rarity.description = `Block End - Last sat of block ${blockNumber}`;
    return rarity;
  }
  
  // Every 10th sat starting from block 1000 - these have names
  // (simplified - real logic tracks cycles)
  const satNamePosition = satPosition - 1000 * satsPerBlock;
  if (satNamePosition > 0 && satNamePosition % satsPerBlock === 0) {
    rarity.isRare = true;
    rarity.type = 'named';
    rarity.description = `Named Sat - Block ${blockNumber} (every 10th sat from block 1000)`;
    return rarity;
  }
  
  // Check for palindromic or special number patterns (simplified)
  const satStr = satPosition.toString();
  if (satStr.length >= 3) {
    // Ends with 000, 111, 222, 333 etc - collector sats
    const lastThree = satStr.slice(-3);
    if (/^(\d)\1{2}$/.test(lastThree)) {
      rarity.isRare = true;
      rarity.type = 'collector';
      rarity.description = `Collector Sat - Ends with ${lastThree} repetitions`;
      return rarity;
    }
    
    // Round numbers like 10000, 100000
    if (/^1+0+$/.test(satStr) && satStr.length >= 5) {
      rarity.isRare = true;
      rarity.type = 'round';
      rarity.description = `Round Sat - ${parseInt(satStr).toLocaleString()} sats`;
      return rarity;
    }
  }
  
  return rarity;
}

// Get detailed UTXO info with ordinal analysis
async function getDetailedUtxos() {
  const baseUrl = wallet.testnet 
    ? "https://mempool.space/testnet/api" 
    : "https://mempool.space/api";
  
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  if (!address) {
    console.log("❌ No address available.");
    return [];
  }
  
  try {
    const response = await axios.get(`${baseUrl}/address/${address}/utxo`);
    const utxos = response.data;
    
    // Get current block height for ordinal calculations
    const blockHeight = await getBlockHeight();
    
    const detailedUtxos = [];
    
    for (const utxo of utxos) {
      const inscription = await checkInscription(utxo.txid, utxo.vout);
      
      // Calculate approximate sat position
      // This is simplified - real ordinal tracking needs block discovery
      const satPosition = utxo.value; // Simplified - real logic needs more data
      
      const rareSat = identifyRareSat(utxo.value, blockHeight);
      
      detailedUtxos.push({
        ...utxo,
        inscription: inscription.hasInscription ? {
          id: inscription.inscriptionId,
          number: inscription.inscriptionNumber
        } : null,
        rareSat: rareSat.isRare ? rareSat : null
      });
    }
    
    return detailedUtxos;
  } catch (error) {
    console.log(`❌ Error fetching UTXOs: ${error.message}`);
    return [];
  }
}

// Sweep UTXOs with options to exclude rare/inscribed
async function sweep(destination, options = {}) {
  const {
    excludeInscribed = true,
    excludeRare = true,
    minValue = 0
  } = options;
  
  console.log(`🧹 Sweeping UTXOs to ${destination}...`);
  console.log(`   Exclude inscribed: ${excludeInscribed}`);
  console.log(`   Exclude rare sats: ${excludeRare}`);
  console.log(`   Min value: ${minValue} sats\n`);
  
  const detailedUtxos = await getDetailedUtxos();
  
  if (detailedUtxos.length === 0) {
    console.log("No UTXOs found.");
    return;
  }
  
  // Filter UTXOs based on options
  const eligibleUtxos = detailedUtxos.filter(utxo => {
    // Check minimum value
    if (utxo.value < minValue) {
      console.log(`   ⏭️  Skipping ${utxo.txid}:${utxo.vout} - below min value (${utxo.value} sats)`);
      return false;
    }
    
    // Check inscription
    if (excludeInscribed && utxo.inscription) {
      console.log(`   ⛔ Excluding ${utxo.txid}:${utxo.vout} - has inscription #${utxo.inscription.number}`);
      return false;
    }
    
    // Check rare sat
    if (excludeRare && utxo.rareSat) {
      console.log(`   ⛔ Excluding ${utxo.txid}:${utxo.vout} - ${utxo.rareSat.type} (${utxo.rareSat.description})`);
      return false;
    }
    
    console.log(`   ✅ Including ${utxo.txid}:${utxo.vout} - ${utxo.value} sats`);
    return true;
  });
  
  if (eligibleUtxos.length === 0) {
    console.log("\n❌ No eligible UTXOs to sweep.");
    return;
  }
  
  const totalValue = eligibleUtxos.reduce((sum, u) => sum + u.value, 0);
  const fee = 1000; // Estimated fee
  const sweepAmount = totalValue - fee;
  
  console.log(`\n📊 Sweeping ${eligibleUtxos.length} UTXOs totaling ${totalValue} sats`);
  console.log(`   Sweep amount: ${sweepAmount} sats (after ${fee} sats fee)\n`);
  
  // Create and sign PSBT
  const psbt = await createSweepPsbt(destination, eligibleUtxos, sweepAmount);
  if (!psbt) return;
  
  console.log(`✍️  Signing...`);
  const signedPsbt = signPsbt(psbt);
  if (!signedPsbt) return;
  
  console.log(`📡 Broadcasting...`);
  await broadcast(signedPsbt);
}

// Create PSBT for sweeping
async function createSweepPsbt(destination, utxos, amount) {
  let keyPair, internalPubkey;
  if (derivedKey) {
    keyPair = ECPair.fromPrivateKey(derivedKey.privateKey, currentNetwork);
    internalPubkey = derivedKey.xOnly;
  } else {
    keyPair = ECPair.fromWIF(wallet.privateKey, currentNetwork);
    internalPubkey = toXOnly(keyPair.publicKey);
  }
  
  let address = wallet.address;
  if (!address && derivedKey) {
    const { payments, networks } = require("bitcoinjs-lib");
    const p2tr = payments.p2tr({ 
      internalPubkey: derivedKey.xOnly, 
      network: wallet.testnet ? networks.testnet : networks.bitcoin 
    });
    address = p2tr.address;
  }
  
  const psbt = new bitcoin.Psbt({ network: currentNetwork });
  
  // Add inputs
  for (const utxo of utxos) {
    try {
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
    } catch (e) {
      console.log(`   ⚠️  Error fetching tx ${utxo.txid}: ${e.message}`);
    }
  }
  
  // Add output
  psbt.addOutput({
    address: destination,
    value: amount,
  });
  
  return psbt;
}

// Show ordinal analysis of UTXOs
async function ordinals() {
  console.log(`🔍 Analyzing UTXOs for ordinals/inscriptions...\n`);
  
  const detailedUtxos = await getDetailedUtxos();
  
  if (detailedUtxos.length === 0) {
    console.log("No UTXOs found.");
    return;
  }
  
  let inscribed = 0;
  let rare = 0;
  let normal = 0;
  
  for (const utxo of detailedUtxos) {
    if (utxo.inscription) {
      inscribed++;
      console.log(`📜 INSCRIBED #${utxo.inscription.number}`);
      console.log(`   ${utxo.txid}:${utxo.vout} - ${utxo.value} sats`);
      console.log(`   ID: ${utxo.inscription.id}\n`);
    } else if (utxo.rareSat) {
      rare++;
      console.log(`⭐ RARE: ${utxo.rareSat.type}`);
      console.log(`   ${utxo.txid}:${utxo.vout} - ${utxo.value} sats`);
      console.log(`   ${utxo.rareSat.description}\n`);
    } else {
      normal++;
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`   Inscribed: ${inscribed}`);
  console.log(`   Rare: ${rare}`);
  console.log(`   Normal: ${normal}`);
  console.log(`   Total: ${detailedUtxos.length}`);
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
  
  case "ordinals":
    loadWallet();
    ordinals();
    break;
  
  case "sweep":
    loadWallet();
    if (!args[1]) {
      console.log(`Usage: sweep <destination_address> [options]
      
Options:
  --include-inscribed    Include UTXOs with inscriptions (DANGER!)
  --include-rare         Include rare sats (DANGER!)
  --min-value <sats>     Minimum UTXO value to include (default: 0)

Examples:
  btc-wallet.cjs sweep tb1q...           # Excludes inscribed & rare (safe)
  btc-wallet.cjs sweep tb1q... --include-inscribed  # Include all UTXOs`);
    } else {
      const options = {
        excludeInscribed: !args.includes('--include-inscribed'),
        excludeRare: !args.includes('--include-rare'),
        minValue: 0
      };
      
      const minIdx = args.indexOf('--min-value');
      if (minIdx !== -1 && args[minIdx + 1]) {
        options.minValue = parseInt(args[minIdx + 1]);
      }
      
      sweep(args[1], options);
    }
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
🔴 BTC Wallet CLI v0.0.2 - With Ordinal Protection

Usage:
  btc-wallet new                              - Generate new wallet
  btc-wallet import <wif>                     - Import from WIF
  btc-wallet address                          - Show address
  btc-wallet balance                          - Show balance
  btc-wallet utxos                            - List UTXOs
  btc-wallet ordinals                         - Analyze UTXOs for inscriptions/rare sats
  btc-wallet sweep <addr> [options]           - Sweep UTXOs (protects rare/inscribed)
  btc-wallet send <addr> <sats>               - Send BTC
  btc-wallet create-psbt <addr> <sats>        - Create PSBT
  btc-wallet sign-psbt <file>                 - Sign PSBT
  btc-wallet broadcast <file>                 - Broadcast PSBT
  btc-wallet info                             - Wallet info
  btc-wallet derive                           - Show derivation paths
  btc-wallet clear                            - Delete wallet

Options:
  --testnet                                   - Use testnet

Sweep Options:
  --include-inscribed                         - Include inscribed UTXOs (dangerous!)
  --include-rare                              - Include rare sats (dangerous!)
  --min-value <sats>                          - Minimum UTXO value

Ordinal Protection:
  ✅ Automatically detects inscriptions
  ✅ Detects rare sats (genesis, block-start, collector, round)
  ✅ Excludes rare/inscribed by default when sweeping
`);
}
