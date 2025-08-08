const { ethers } = require("ethers");
const axios = require("axios");
const FlashArbitrageurABI = require('../artifacts/contracts/FlashArbitrageur.sol/FlashArbitrageur.json').abi;
require("dotenv").config();

// --- CONFIGURATION ---
const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ARBITRAGEUR_ADDRESS = "0xbFB12a88236aA3569d95ae645dAa0BC300901168";
const contract = new ethers.Contract(ARBITRAGEUR_ADDRESS, FlashArbitrageurABI, wallet);

const ZERO_EX_API_KEY = process.env.ZERO_EX_API_KEY;

// Tokens and settings
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const LOAN_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC
const MIN_PROFIT_THRESHOLD = ethers.parseUnits("0.1", 6); // Minimum profit of 0.1 USDC

// --- API HELPER ---
async function getQuote(params) {
  const headers = { '0x-api-key': ZERO_EX_API_KEY || '' };
  try {
    const response = await axios.get('https://polygon.api.0x.org/swap/v1/quote', { params, headers });
    return response.data;
  } catch (error) {
    // Improved error logging
    const errorDetails = error.response ? error.response.data.reason : error.message;
    console.error(`[ERROR] Quote request failed: ${errorDetails}`);
    return null;
  }
}

// --- MAIN BOT LOGIC ---
async function executeTrade(asset, amount, tradeData) {
    console.log(`\x1b[32m[EXECUTION] Attempting to execute arbitrage...\x1b[0m`);
    try {
        const tx = await contract.executeArbitrage(
            asset,
            amount,
            tradeData,
            { gasLimit: 1000000 }
        );

        console.log(`[SUCCESS] Transaction sent! Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[CONFIRMED] Transaction confirmed in block ${receipt.blockNumber}`);

        const profitEvent = receipt.logs.find(log => log.address === ARBITRAGEUR_ADDRESS && contract.interface.parseLog(log)?.name === 'ProfitRealized');
        if (profitEvent) {
            const parsedLog = contract.interface.parseLog(profitEvent);
            const profit = parsedLog.args.profit;
            console.log(`\x1b[32m[PROFIT REALIZED] ${ethers.formatUnits(profit, 6)} USDC\x1b[0m`);
        }
        return tx.hash;
    } catch (error) {
        console.error("\x1b[31m[EXECUTION FAILED]\x1b[0m", error.reason || error.message);
        return null;
    }
}

async function scan() {
  console.log("-----------------------------------------");
  console.log(`Scanning for arbitrage opportunities at ${new Date().toLocaleTimeString()}`);

  const quote = await getQuote({
    sellToken: USDC_ADDRESS,
    buyToken: USDC_ADDRESS,
    sellAmount: LOAN_AMOUNT.toString(),
    takerAddress: ARBITRAGEUR_ADDRESS,
  });

  if (!quote) {
    console.log("[INFO] No profitable route found in this cycle.");
    return;
  }

  const expectedReturn = BigInt(quote.buyAmount);
  const profit = expectedReturn - LOAN_AMOUNT;

  console.log(`Initial Amount: ${ethers.formatUnits(LOAN_AMOUNT, 6)} USDC`);
  console.log(`Expected Return:  ${ethers.formatUnits(expectedReturn, 6)} USDC`);
  console.log(`Potential Profit: ${ethers.formatUnits(profit, 6)} USDC`);

  if (profit > MIN_PROFIT_THRESHOLD) {
    console.log(`\x1b[32m[PROFITABLE ROUTE FOUND!]\x1b[0m`);
    const tradeData = quote.data;
    await executeTrade(USDC_ADDRESS, LOAN_AMOUNT, tradeData);
  } else {
    console.log(`\x1b[31m[NO PROFIT] Profit does not meet threshold of ${ethers.formatUnits(MIN_PROFIT_THRESHOLD, 6)} USDC.\x1b[0m`);
  }
}

// --- MAIN LOOP ---
console.log("Arbitrage Bot Started. Press Ctrl+C to stop.");
scan();
// Updated to scan every 5 seconds
setInterval(scan, 5000);
