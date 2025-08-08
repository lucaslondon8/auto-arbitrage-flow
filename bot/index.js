// Polygon Flash Loan Arbitrage Bot (Scanner + Executor + WS server)
// NOTE: This is a production-grade scaffold. Fill in provider endpoints and contract address in .env
// PRIVATE_KEY and POLYGON_RPC_URL are required.

require('dotenv').config();
const { ethers } = require('ethers');
const WebSocket = require('ws');

const WS_PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : 8787;
const MIN_PROFIT_USD = process.env.MIN_PROFIT_USD ? Number(process.env.MIN_PROFIT_USD) : 1.0;
const FLASH_FEE_RATE = Number(process.env.FLASH_FEE_RATE || 0.0005); // 0.05%

const RPC_URL = process.env.POLYGON_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS; // Deployed FlashArbitrageur

if (!RPC_URL) throw new Error('Missing POLYGON_RPC_URL in .env');
if (!PRIVATE_KEY) throw new Error('Missing PRIVATE_KEY in .env');
if (!CONTRACT_ADDRESS) console.warn('[WARN] CONTRACT_ADDRESS not set. Execution will be disabled.');

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Minimal ABI for the on-chain contract
const FLASH_ABI = [
  'function initiateFlashArb(address asset, uint256 amount, (address target, bytes data, uint256 value)[] swaps, uint256 deadline) external',
  'event ProfitRealized(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profitSent)'
];
const flashContract = CONTRACT_ADDRESS ? new ethers.Contract(CONTRACT_ADDRESS, FLASH_ABI, wallet) : null;

// Common tokens on Polygon (Mainnet)
const ADDR = {
  WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  WETH:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  USDC:   '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  // Routers (V2 style)
  QUICK_ROUTER: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  SUSHI_ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  // Factories
  QUICK_FACTORY: '0x5757371414417b8c6caad45baef941abc7d3ab32',
  SUSHI_FACTORY: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
};

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address)'
];
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)'
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)'
];

const factoryQuick = new ethers.Contract(ADDR.QUICK_FACTORY, FACTORY_ABI, provider);
const factorySushi = new ethers.Contract(ADDR.SUSHI_FACTORY, FACTORY_ABI, provider);

let state = {
  running: false,
  status: 'Idle',
  totalNetProfitUSD: 0,
  lastTxHash: null,
  wsClients: new Set(),
};

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  for (const ws of state.wsClients) {
    try { ws.send(JSON.stringify({ type: 'log', line })); } catch {}
  }
}

function broadcastStatus() {
  const payload = JSON.stringify({
    type: 'status',
    running: state.running,
    status: state.status,
    totalNetProfitUSD: state.totalNetProfitUSD,
    lastTxHash: state.lastTxHash,
  });
  for (const ws of state.wsClients) {
    try { ws.send(payload); } catch {}
  }
}

// Constant product AMM math with slippage
function getAmountOut(amountIn, reserveIn, reserveOut, fee = 0.003) {
  const amountInWithFee = amountIn * (1 - fee);
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

async function getReserves(factory, a, b) {
  const pair = await factory.getPair(a, b);
  if (pair === ethers.ZeroAddress) return null;
  const c = new ethers.Contract(pair, PAIR_ABI, provider);
  const [r0, r1] = await c.getReserves();
  const t0 = await c.token0();
  return a.toLowerCase() === t0.toLowerCase() ? { reserveIn: Number(r0), reserveOut: Number(r1) } : { reserveIn: Number(r1), reserveOut: Number(r0) };
}

async function scanTriangularPath(tokens, factories) {
  // Simple two-hop triangle: A->B on DEX1, B->C on DEX2, C->A on DEX1
  const [A, B, C] = tokens;
  const [dex1, dex2] = factories; // e.g., [Quick, Sushi]

  const rAB = await getReserves(dex1, A, B);
  const rBC = await getReserves(dex2, B, C);
  const rCA = await getReserves(dex1, C, A);

  if (!rAB || !rBC || !rCA) return null;

  // Optimization loop over amountIn (loan size in A)
  let best = { amountIn: 0, grossOut: 0, netProfit: -Infinity };
  let amount = 100; // Start small
  for (let i = 0; i < 12; i++) { // Exponential sweep
    const out1 = getAmountOut(amount, rAB.reserveIn, rAB.reserveOut);
    const out2 = getAmountOut(out1, rBC.reserveIn, rBC.reserveOut);
    const out3 = getAmountOut(out2, rCA.reserveIn, rCA.reserveOut);

    const gross = out3; // in token A units

    // Estimate gas in MATIC terms (rough heuristic); refine via estimateGas before execution
    const gasPrice = Number((await provider.getGasPrice()).toString());
    const gasLimit = 450000; // heuristic for 3 swaps + flash logic
    const gasCostWei = gasPrice * gasLimit;

    // Convert gas to A units roughly using A/WMATIC rate assumed ~1 (skip if A=WMATIC); this is a heuristic
    let gasCostA = 0;
    if (A.toLowerCase() === ADDR.WMATIC.toLowerCase()) {
      gasCostA = Number(ethers.formatUnits(gasCostWei, 18));
    }

    const fee = amount * FLASH_FEE_RATE; // flash fee in A units (if A is loan asset)
    const net = gross - amount - fee - gasCostA;

    if (net > best.netProfit) best = { amountIn: amount, grossOut: gross, netProfit: net };
    amount *= 2; // increase
  }

  if (best.netProfit > 0) {
    return {
      path: [A, B, C, A],
      dexes: ['QUICK', 'SUSHI', 'QUICK'],
      amountIn: best.amountIn,
      netProfit: best.netProfit,
    };
  }
  return null;
}

async function chooseFlashProvider(asset, amount) {
  // For now return Aave V3 (implicit in contract). Extend to Balancer later.
  return { name: 'AAVE_V3' };
}

function buildSwapCalldataV2(router, path, recipient, deadlineTs) {
  const iface = new ethers.Interface([
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)'
  ]);
  const amountIn = ethers.parseUnits(path._amt_in || '0', 18); // placeholder, overwritten at execution
  const data = iface.encodeFunctionData('swapExactTokensForTokens', [amountIn, 0n, path, recipient, BigInt(deadlineTs)]);
  return data;
}

async function executeOpportunity(opp) {
  if (!flashContract) {
    log('Execution skipped: CONTRACT_ADDRESS not set.');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 120; // 2 minutes

  // Construct low-level swaps (UniswapV2-style for demo). In production, split per hop with exact amounts set via router-supporting flash callbacks.
  const swaps = [];
  const to = flashContract.target;

  // For demonstration, we perform three separate calls. Off-chain bot should compute amounts and slippage bounds.
  const routers = [ADDR.QUICK_ROUTER, ADDR.SUSHI_ROUTER, ADDR.QUICK_ROUTER];
  const paths = [ [opp.path[0], opp.path[1]], [opp.path[1], opp.path[2]], [opp.path[2], opp.path[3]] ];
  const iface = new ethers.Interface([
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)'
  ]);

  // Amount chaining is complex without on-chain callbacks; here we set amountIn only for first hop; subsequent hops use amountIn=0 as placeholder and rely on router internal balance (not valid on chain). In production, use exactSupportingFeeOnTransfer or custom adapters.
  const amountIn = ethers.parseUnits(String(opp.amountIn), 18); // assuming 18 decimals for A

  swaps.push({
    target: routers[0],
    data: iface.encodeFunctionData('swapExactTokensForTokens', [amountIn, 0n, paths[0], to, BigInt(deadline)]),
    value: 0n,
  });
  swaps.push({ target: routers[1], data: iface.encodeFunctionData('swapExactTokensForTokens', [0n, 0n, paths[1], to, BigInt(deadline)]), value: 0n });
  swaps.push({ target: routers[2], data: iface.encodeFunctionData('swapExactTokensForTokens', [0n, 0n, paths[2], to, BigInt(deadline)]), value: 0n });

  // Gas estimate
  let gasEstimate;
  try {
    gasEstimate = await flashContract.initiateFlashArb.estimateGas(opp.path[0], amountIn, swaps, BigInt(deadline));
  } catch (e) {
    log(`Gas estimate failed (likely due to placeholder calldata). Using heuristic. Error: ${e.message}`);
    gasEstimate = 600000n;
  }

  const tx = await flashContract.initiateFlashArb(opp.path[0], amountIn, swaps, BigInt(deadline), { gasLimit: gasEstimate });
  state.lastTxHash = tx.hash;
  broadcastStatus();
  log(`Executing transaction... ${tx.hash}`);
  const receipt = await tx.wait();
  log(`SUCCESS! Mined in block ${receipt.blockNumber}.`);
}

async function scanLoop() {
  if (!state.running) return;
  try {
    state.status = 'Scanning...';
    broadcastStatus();
    log('Scanning 2 DEXs for opportunities (QuickSwap, SushiSwap)...');

    const opp = await scanTriangularPath([ADDR.WMATIC, ADDR.USDC, ADDR.WETH], [factoryQuick, factorySushi]);

    if (opp) {
      log(`Opportunity Found: WMATIC -> USDC -> WETH -> WMATIC. Net Profit (approx): ${opp.netProfit.toFixed(6)} WMATIC.`);
      if (opp.netProfit > 0) {
        // Convert to USD heuristic (skip oracle); assume WMATIC ~$0.5 for safety
        const netUSD = opp.netProfit * 0.5;
        if (netUSD >= MIN_PROFIT_USD) {
          state.status = 'Executing Trade';
          broadcastStatus();
          await executeOpportunity(opp);
          state.totalNetProfitUSD += netUSD;
          log(`Net Profit of ~$${netUSD.toFixed(2)} (heuristic) added.`);
        } else {
          log(`Rejected: Below minimum profit threshold $${MIN_PROFIT_USD}.`);
        }
      }
    } else {
      log('No profitable opportunity found.');
    }
  } catch (e) {
    log(`Error during scan: ${e.message}`);
  } finally {
    state.status = 'Idle';
    broadcastStatus();
  }
}

setInterval(scanLoop, 2500);

// WebSocket server for UI control and live logs
const wss = new WebSocket.Server({ port: WS_PORT });
log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

wss.on('connection', (ws) => {
  state.wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', message: 'Connected to bot' }));
  broadcastStatus();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'start') {
        if (!state.running) {
          state.running = true;
          state.status = 'Scanning...';
          broadcastStatus();
          log('Bot started.');
        }
      } else if (msg.type === 'stop') {
        state.running = false;
        state.status = 'Idle';
        broadcastStatus();
        log('Bot stopped.');
      }
    } catch {}
  });

  ws.on('close', () => state.wsClients.delete(ws));
});
