const { ethers } = require("ethers");
const axios = require("axios");
const FlashArbitrageurABI = require('../artifacts/contracts/FlashArbitrageur.sol/FlashArbitrageur.json').abi;
require("dotenv").config();

// --- CONFIGURATION ---
const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ARBITRAGEUR_ADDRESS = "0xbFB12a88236aA3569d95ae645dAa0BC300901168";
const contract = new ethers.Contract(ARBITRAGEUR_ADDRESS, FlashArbitrageurABI, wallet);

const ZERO_EX_API_KEY = process.env.ZERO_EX_API_KEY || '';

// Tokens and settings (Polygon)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // 6 decimals
const WMATIC_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // 18 decimals

// Dynamic sizing candidates (USDC)
const CANDIDATE_AMOUNTS_USDC = [100, 250, 500, 1000, 2000, 5000, 10000].map(a => ethers.parseUnits(a.toString(), 6));

// Profitability and cost parameters
const MIN_PROFIT_THRESHOLD = ethers.parseUnits("0.1", 6); // 0.1 USDC
const FLASH_LOAN_FEE_BPS = 9n; // Aave v3 0.09%
const SLIPPAGE_BPS = 50n; // 0.50% slippage tolerance for quotes
const BASE_FLASH_ARBITRAGE_GAS = 350000n; // overhead for flash loan + internal logic

// DEX sources to compare via 0x (Polygon)
const DEX_SOURCES = ["QuickSwap", "SushiSwap", "Uniswap_V3"]; // 0x source names

// --- API HELPERS ---
async function getQuote(params) {
  const headers = { '0x-api-key': ZERO_EX_API_KEY };
  try {
    const response = await axios.get('https://polygon.api.0x.org/swap/v1/quote', { params, headers });
    return response.data;
  } catch (error) {
    const details = error?.response?.data?.validationErrors?.[0]?.reason || error?.response?.data?.reason || error.message;
    console.error(`[ERROR] 0x Quote failed: ${details}`);
    return null;
  }
}

async function getDexQuote({ sellToken, buyToken, sellAmount, includedSources, slippageBps }) {
  const params = {
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    takerAddress: ARBITRAGEUR_ADDRESS,
    slippagePercentage: Number(slippageBps) / 10000,
  };
  if (includedSources) params.includedSources = includedSources;
  return await getQuote(params);
}

async function getGasPriceWei() {
  const feeData = await provider.getFeeData();
  // Prefer EIP-1559 maxFeePerGas if present, else fallback
  return (feeData.maxFeePerGas || feeData.gasPrice || 30n * 10n ** 9n); // default 30 gwei
}

async function getMaticToUsdcPrice6() {
  // Fetch USDC received for selling 1 WMATIC (1e18), as a USDC 6-decimal amount
  const oneWmatic = ethers.parseUnits("1", 18);
  const q = await getQuote({
    sellToken: WMATIC_ADDRESS,
    buyToken: USDC_ADDRESS,
    sellAmount: oneWmatic.toString(),
    takerAddress: ARBITRAGEUR_ADDRESS,
  });
  if (!q) return null;
  return BigInt(q.buyAmount); // 6 decimals
}

function getQuoteGasUnits(quote) {
  const g = quote?.estimatedGas ?? quote?.gas;
  try {
    return g ? BigInt(g) : 0n;
  } catch {
    return 0n;
  }
}

function applyBps(amount, bps) {
  return (amount * bps) / 10000n;
}

function amountOutMinAfterSlippage(amountOut, slippageBps) {
  return amountOut - applyBps(amountOut, slippageBps);
}

async function estimateGasCostInUsdc6(totalGasUnits, gasPriceWei, maticToUsdc6) {
  // cost (wei) = totalGas * gasPrice
  const costWei = totalGasUnits * gasPriceWei;
  // Convert MATIC wei -> USDC 6-dec using 1 WMATIC -> maticToUsdc6
  // USDC6 = (costWei / 1e18) * maticToUsdc6  => with BigInt: (costWei * maticToUsdc6) / 1e18
  const oneEth = 10n ** 18n;
  return (costWei * maticToUsdc6) / oneEth; // 6 decimals
}

async function evaluateTwoLegArb({ amountUSDC6, buyOnSource, sellOnSource, gasPriceWei, maticToUsdc6 }) {
  // 1) USDC -> WMATIC on buyOnSource
  const leg1 = await getDexQuote({
    sellToken: USDC_ADDRESS,
    buyToken: WMATIC_ADDRESS,
    sellAmount: amountUSDC6,
    includedSources: buyOnSource,
    slippageBps: SLIPPAGE_BPS,
  });
  if (!leg1) return null;

  // 2) WMATIC -> USDC on sellOnSource (sell the exact amount bought in leg1)
  const leg1OutWmatic = BigInt(leg1.buyAmount);
  if (leg1OutWmatic === 0n) return null;
  const leg2 = await getDexQuote({
    sellToken: WMATIC_ADDRESS,
    buyToken: USDC_ADDRESS,
    sellAmount: leg1OutWmatic,
    includedSources: sellOnSource,
    slippageBps: SLIPPAGE_BPS,
  });
  if (!leg2) return null;

  // Gross return and profit
  const grossReturnUSDC6 = BigInt(leg2.buyAmount);
  const grossProfitUSDC6 = grossReturnUSDC6 - amountUSDC6;

  // Flash loan fee
  const flashFee = applyBps(amountUSDC6, FLASH_LOAN_FEE_BPS);

  // Gas estimation: sum per-quote gas + base overhead
  const gasLeg1 = getQuoteGasUnits(leg1);
  const gasLeg2 = getQuoteGasUnits(leg2);
  const totalGasUnits = gasLeg1 + gasLeg2 + BASE_FLASH_ARBITRAGE_GAS;
  const gasCostUSDC6 = await estimateGasCostInUsdc6(totalGasUnits, gasPriceWei, maticToUsdc6);

  // Net profit
  const netProfitUSDC6 = grossProfitUSDC6 - flashFee - gasCostUSDC6;

  // Slippage-protected min-out for the final leg
  const minOutUSDC6 = amountOutMinAfterSlippage(grossReturnUSDC6, SLIPPAGE_BPS);

  return {
    amountUSDC6,
    buyOnSource,
    sellOnSource,
    leg1,
    leg2,
    totalGasUnits,
    gasCostUSDC6,
    flashFee,
    grossProfitUSDC6,
    netProfitUSDC6,
    minOutUSDC6,
  };
}

async function findBestOpportunity() {
  // Cache environment-wide data for the scan cycle
  const [gasPriceWei, maticToUsdc6] = await Promise.all([getGasPriceWei(), getMaticToUsdcPrice6()]);
  if (!maticToUsdc6) {
    console.log("[INFO] Skipping cycle: could not fetch WMATIC->USDC price.");
    return null;
  }

  let best = null;
  for (const amount of CANDIDATE_AMOUNTS_USDC) {
    for (const buySource of DEX_SOURCES) {
      for (const sellSource of DEX_SOURCES) {
        if (buySource === sellSource) continue;
        const res = await evaluateTwoLegArb({ amountUSDC6: amount, buyOnSource: buySource, sellOnSource: sellSource, gasPriceWei, maticToUsdc6 });
        if (!res) continue;
        if (!best || res.netProfitUSDC6 > best.netProfitUSDC6) best = res;
      }
    }
  }
  return best;
}

function formatUSDC(x) { return Number(ethers.formatUnits(x, 6)).toFixed(4); }
function formatGwei(x) { return Number(ethers.formatUnits(x, 9)).toFixed(2); }

function buildTradeData(leg1, leg2, minOutUSDC6) {
  // NOTE: This encoding assumes the smart contract decodes (bytes leg1Call, bytes leg2Call, uint256 minOut)
  // and sequentially performs the two swaps, enforcing the minOut on the last hop.
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.encode(["bytes", "bytes", "uint256"], [leg1.data, leg2.data, minOutUSDC6]);
  } catch (e) {
    console.error("[ERROR] Failed to build trade data:", e.message);
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
      { gasLimit: 1_500_000 }
    );

    console.log(`[SUCCESS] Transaction sent! Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[CONFIRMED] Transaction confirmed in block ${receipt.blockNumber}`);

    const profitEvent = receipt.logs.find(log => {
      try {
        const parsed = contract.interface.parseLog(log);
        return log.address.toLowerCase() === ARBITRAGEUR_ADDRESS.toLowerCase() && parsed?.name === 'ProfitRealized';
      } catch { return false; }
    });
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
  console.log(`Scanning for arbitrage at ${new Date().toLocaleTimeString()}`);

  const best = await findBestOpportunity();
  if (!best) {
    console.log("[INFO] No viable opportunities in this cycle.");
    return;
  }

  const {
    amountUSDC6,
    buyOnSource,
    sellOnSource,
    leg1,
    leg2,
    totalGasUnits,
    gasCostUSDC6,
    flashFee,
    grossProfitUSDC6,
    netProfitUSDC6,
    minOutUSDC6,
  } = best;

  console.log(`[CANDIDATE] Amount=${formatUSDC(amountUSDC6)} USDC | Buy on ${buyOnSource} -> Sell on ${sellOnSource}`);
  console.log(`  Gross Profit: ${formatUSDC(grossProfitUSDC6)} USDC`);
  console.log(`  Flash Fee:    ${formatUSDC(flashFee)} USDC ( ${Number(FLASH_LOAN_FEE_BPS)/100}% )`);
  console.log(`  Gas:          ${totalGasUnits.toString()} units (~${formatUSDC(gasCostUSDC6)} USDC)`);
  console.log(`  Net Profit:   ${formatUSDC(netProfitUSDC6)} USDC`);

  if (netProfitUSDC6 > MIN_PROFIT_THRESHOLD) {
    console.log(`\x1b[32m[PROFITABLE ROUTE FOUND] Net Profit ${formatUSDC(netProfitUSDC6)} USDC > Threshold ${formatUSDC(MIN_PROFIT_THRESHOLD)} USDC\x1b[0m`);

    // Build slippage-protected trade payload (2 legs + minOut)
    const tradeData = buildTradeData(leg1, leg2, minOutUSDC6);
    if (!tradeData) {
      console.log("[WARN] Could not build tradeData. Skipping execution.");
      return;
    }

    await executeTrade(USDC_ADDRESS, amountUSDC6, tradeData);
  } else {
    console.log(`\x1b[31m[NO TRADE] Net profit below threshold (${formatUSDC(MIN_PROFIT_THRESHOLD)} USDC).\x1b[0m`);
  }
}

// --- MAIN LOOP ---
console.log("Arbitrage Bot Started. Press Ctrl+C to stop.");
scan();
setInterval(scan, 5000);
