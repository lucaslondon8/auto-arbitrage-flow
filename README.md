# Polygon Flash Loan Arbitrage Bot

Autonomous, slippage-aware flash loan arbitrage system for the Polygon (PoS) network. Ships with:
- On-chain contract: Aave V3 flash-loan receiver executing arbitrary DEX swaps via low-level calls
- Off-chain bot: High-frequency scanner + executor with WebSocket bridge for live UI
- Minimal, data-focused dashboard UI (React + Tailwind) with Start/Stop, status, live logs, and profit

IMPORTANT: This repository includes production-grade scaffolding and secure patterns. You must deploy the contract and run the bot locally with your private RPC to begin.

---

## 1) Quick Start (ADHD-friendly)

1. Clone & install
   - git clone <YOUR_GIT_URL>
   - cd <YOUR_PROJECT_NAME>
   - npm i

2. Deploy the smart contract (Remix easiest)
   - Open Remix → create `contracts/FlashArbitrageur.sol` (already in this repo)
   - Compile with Solidity ^0.8.20
   - Polygon Mainnet: set constructor arg `addressesProvider` to Aave V3 AddressesProvider → `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb`
   - Deploy (ensure your wallet has MATIC for gas)
   - Copy the deployed contract address → use it as CONTRACT_ADDRESS below

3. Create .env in project root
   - PRIVATE_KEY=your_wallet_private_key (use a dedicated, funded hot wallet)
   - POLYGON_RPC_URL=https://your-low-latency-private-rpc
   - CONTRACT_ADDRESS=0xYourDeployedContract
   - (optional) MIN_PROFIT_USD=1

4. Fund wallet with MATIC (≥ 0.5 MATIC recommended)

5. Start the bot (local Node script)
   - node bot/index.js

6. Start the UI (separate terminal)
   - npm run dev
   - Open http://localhost:8080
   - Ensure WS URL is ws://localhost:8787 in the Setup card
   - Press START to begin scanning/execution

---

## 2) Security & Guarantees

- On-chain contract reverts unless post-swap balance ≥ loan + fee (no loss via flash-loan)
- Uses nonReentrant guard and ownership (only owner can trigger flash-loan)
- Profit automatically transferred to owner()
- All swaps include a deadline to avoid stale execution

---

## 3) Contract Overview (contracts/FlashArbitrageur.sol)

- Implements Aave V3 `IFlashLoanSimpleReceiver` on Polygon
- `initiateFlashArb(asset, amount, swaps[], deadline)` → triggers flash-loan and passes a list of low-level calls (Swap target, data, value)
- `executeOperation(...)` performs the calls, verifies profitability, approves repayment, transfers profit to owner
- Event: `ProfitRealized(asset, amountBorrowed, premium, profitSent)`

Recommended deploy on Polygon (Aave V3):
- AddressesProvider: `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb`

---

## 4) Off-Chain Bot (bot/index.js)

- Connects to your private Polygon RPC for low latency
- Scans QuickSwap + SushiSwap (V2 style) for a basic triangular path (WMATIC → USDC → WETH → WMATIC)
- Models slippage via constant-product formula; iteratively increases loan size to approximate the profit maximum
- Checks net profit (gross − flash fee − gas heuristic). Only executes when above threshold
- Builds calldata for contract and submits transaction (gas estimate attempted; uses heuristic if estimate fails)
- WebSocket server (ws://localhost:8787) streams live logs + status to UI and accepts START/STOP commands

Extensibility TODOs:
- Add Uniswap V3 (Quoter V2), Curve, Balancer adapters for deeper coverage
- Refine gas modeling via `estimateGas` with full calldata and pre-approvals
- MEV mitigation: integrate Polygon private transaction relays (e.g., Alchemy/Blocknative/BloXroute)

---

## 5) UI (src/pages/Index.tsx)

- Start/Stop button
- Status indicator (Idle/Scanning/Executing)
- Total net profit (from bot heuristic)
- Live log console (auto-scrolling)
- Setup section for WS URL

---

## 6) Notes on Keys & RPC

- Never commit your PRIVATE_KEY or RPC URL.
- Use a dedicated wallet limited to this bot.
- Prefer a private Polygon RPC (Infura/Alchemy custom) for low-latency reads and better reliability.

---

## 7) Commands

UI:
- npm run dev → launches the web interface

Bot:
- node bot/index.js → starts the scanner + WS server

Deployment (option A: Remix):
- Compile and deploy `contracts/FlashArbitrageur.sol` with Aave AddressesProvider

---

## 8) Disclaimers

- This is a reference implementation. Profitability depends on live liquidity and timing.
- Expand DEX coverage and add private relays to reduce MEV/fill risk.
- You are responsible for securing keys and infrastructure.
