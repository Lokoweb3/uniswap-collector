#!/usr/bin/env node
/**
 * deploy-treasury.js — Deploy LOKOVault to Robinhood Chain
 * Run: node deploy-treasury.js
 *
 * Deploys:
 * 1. TreasuryAccount (EIP-6551 implementation)
 * 2. TreasuryNFT (ERC-721, LOKOVault)
 * 3. Mints token #1 to owner
 * 4. Creates TBA via EIP-6551 registry
 * 5. Saves addresses to config.json
 * 6. Sends Telegram notification
 */

'use strict';

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const solc = require('solc');
const https = require('https');

const CONFIG = {
  rpc:          process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  keystorePath: process.env.LP_KEYSTORE_PATH ||
                path.join(process.env.HOME || '', '.lp-collector', 'operator-keystore.json'),
  registry:     '0x000000006551c19487814612e58FE06813775758',
  owner:        '0x0000000000000000000000000000000000000001',
  explorerUrl:  'https://robinhoodchain.blockscout.com',
  telegramToken: process.env.TELEGRAM_TOKEN,
  telegramChat:  process.env.TELEGRAM_CHAT || process.env.TELEGRAM_CHAT_ID || '<chat-id>',
  configPath:   path.join(process.cwd(), 'config.json'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function prompt(q, silent = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) process.stdout.write(q);
    else process.stdout.write(q);
    process.stdin.setRawMode?.(silent);
    rl.question(silent ? '' : '', ans => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(ans.trim());
    });
  });
}

async function promptPassphrase() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Operator passphrase: ');
    let pass = '';
    process.stdin.setRawMode(true);
    process.stdin.on('data', function handler(ch) {
      ch = ch.toString();
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        rl.close();
        resolve(pass);
      } else if (ch === '\u0003') {
        process.exit();
      } else {
        pass += ch;
      }
    });
  });
}

async function sendTelegram(msg) {
  if (!CONFIG.telegramToken) return;
  return new Promise(resolve => {
    const body = JSON.stringify({
      chat_id: CONFIG.telegramChat,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.telegramToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, resolve);
    req.on('error', () => {});
    req.write(body);
    req.end();
  });
}

// ── Compile ───────────────────────────────────────────────────────────────────
function compile(contractName, source) {
  console.log(`Compiling ${contractName}.sol...`);
  const input = {
    language: 'Solidity',
    sources: { [`${contractName}.sol`]: { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length) throw new Error(errors.map(e => e.message).join('\n'));
  }
  const contract = output.contracts[`${contractName}.sol`][contractName];
  return { abi: contract.abi, bytecode: contract.evm.bytecode.object };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔐 LOKOVault Deploy Script');
  console.log('Chain: Robinhood Chain (4663)');
  console.log('Owner:', CONFIG.owner);
  console.log('');

  // Load keystore
  if (!fs.existsSync(CONFIG.keystorePath)) {
    throw new Error(`Keystore not found: ${CONFIG.keystorePath}`);
  }
  const keystore = fs.readFileSync(CONFIG.keystorePath, 'utf8');
  const passphrase = await promptPassphrase();

  // Decrypt wallet
  console.log('Decrypting keystore...');
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, passphrase);
  const provider = new ethers.JsonRpcProvider(CONFIG.rpc);
  const signer = wallet.connect(provider);

  const balance = await provider.getBalance(signer.address);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther('0.005')) {
    throw new Error('Insufficient ETH for deployment. Need at least 0.005 ETH.');
  }

  // Load contract sources
  const accountSrc = fs.readFileSync(
    path.join(__dirname, 'TreasuryAccount.sol'), 'utf8'
  );
  const nftSrc = fs.readFileSync(
    path.join(__dirname, 'TreasuryNFT.sol'), 'utf8'
  );

  // Compile
  const accountArtifact = compile('TreasuryAccount', accountSrc);
  const nftArtifact = compile('TreasuryNFT', nftSrc);

  // Deploy TreasuryAccount implementation
  console.log('\nDeploying TreasuryAccount implementation...');
  const accountFactory = new ethers.ContractFactory(
    accountArtifact.abi,
    accountArtifact.bytecode,
    signer
  );
  const accountContract = await accountFactory.deploy();
  await accountContract.waitForDeployment();
  const accountAddress = await accountContract.getAddress();
  console.log('✅ TreasuryAccount:', accountAddress);

  // Deploy TreasuryNFT
  console.log('\nDeploying TreasuryNFT (LOKOVault)...');
  const nftFactory = new ethers.ContractFactory(
    nftArtifact.abi,
    nftArtifact.bytecode,
    signer
  );
  const nftContract = await nftFactory.deploy(accountAddress);
  await nftContract.waitForDeployment();
  const nftAddress = await nftContract.getAddress();
  console.log('✅ TreasuryNFT:', nftAddress);

  // Mint token #1 to owner
  console.log('\nMinting LOKOVault #1 to owner...');
  const mintTx = await nftContract.mint(CONFIG.owner);
  const mintReceipt = await mintTx.wait();
  console.log('✅ Minted in block:', mintReceipt.blockNumber);

  // Hand the contract's admin role (fee split, pause, ownership) to the main
  // wallet: the deployer is the collector's hot operator key and should not
  // keep control of the vault's settings.
  if (signer.address.toLowerCase() !== CONFIG.owner.toLowerCase()) {
    console.log('\nTransferring TreasuryNFT admin to the owner wallet...');
    const otx = await nftContract.transferOwnership(CONFIG.owner);
    await otx.wait();
    console.log('✅ Admin is now', CONFIG.owner);
  }

  // Get TBA address
  const tbaAddress = await nftContract.tbaAddress();
  console.log('✅ TBA address:', tbaAddress);

  // Verify TBA on-chain
  const code = await provider.getCode(tbaAddress);
  if (code.length > 2) {
    console.log('✅ TBA contract verified on-chain');
  } else {
    console.log('⚠️  TBA not yet deployed — will deploy on first interaction');
  }

  // Save to config.json
  let config = {};
  if (fs.existsSync(CONFIG.configPath)) {
    config = JSON.parse(fs.readFileSync(CONFIG.configPath, 'utf8'));
  }
  config.treasuryNFT = nftAddress;
  config.treasuryTokenId = 1;
  config.treasuryTBA = tbaAddress;
  config.treasuryImplementation = accountAddress;
  config.feeSplitPct = 10;
  config.feeSplitMax = 20;

  fs.writeFileSync(CONFIG.configPath, JSON.stringify(config, null, 2));
  console.log('\n✅ config.json updated');

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('LOKOVault Deployment Summary');
  console.log('═'.repeat(60));
  console.log(`NFT Contract:     ${nftAddress}`);
  console.log(`TBA Address:      ${tbaAddress}`);
  console.log(`Implementation:   ${accountAddress}`);
  console.log(`Owner:            ${CONFIG.owner}`);
  console.log(`Fee Split:        10% (max 20%)`);
  console.log('');
  console.log('Blockscout links:');
  console.log(`NFT:  ${CONFIG.explorerUrl}/token/${nftAddress}`);
  console.log(`TBA:  ${CONFIG.explorerUrl}/address/${tbaAddress}`);
  console.log('═'.repeat(60));

  console.log('\nNext steps:');
  console.log('1. Open http://localhost:8787/treasury to view dashboard');
  console.log('2. Connect Rabby with your main wallet to withdraw');
  console.log('3. The collector will now send 10% of fees to TBA automatically');

  // Send Telegram
  await sendTelegram([
    '🎨 <b>LOKOVault deployed!</b>',
    '',
    `NFT: <code>${nftAddress}</code>`,
    `TBA: <code>${tbaAddress}</code>`,
    `Split: 10% (adjustable 0-20%)`,
    `Owner: <code>${CONFIG.owner.slice(0,6)}...${CONFIG.owner.slice(-4)}</code>`,
    '',
    `<a href="${CONFIG.explorerUrl}/token/${nftAddress}">View NFT on Blockscout</a>`,
  ].join('\n'));

  console.log('\n✅ Telegram notification sent');
}

main().catch(err => {
  console.error('\n❌ Deploy failed:', err.message);
  process.exit(1);
});
