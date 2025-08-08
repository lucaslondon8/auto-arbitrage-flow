// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * FlashArbitrageur
 * - Aave V3 Simple Flash Loan receiver for Polygon
 * - Executes a sequence of low-level DEX calls passed in calldata
 * - Verifies profitability and repays loan + premium atomically
 * - Sends profit to owner immediately
 */

interface IERC20 {
  function balanceOf(address) external view returns (uint256);
  function transfer(address,uint256) external returns (bool);
  function approve(address,uint256) external returns (bool);
}

interface IPoolAddressesProvider { function getPool() external view returns (address); }

interface IPool {
  function flashLoanSimple(
    address receiverAddress,
    address asset,
    uint256 amount,
    bytes calldata params,
    uint16 referralCode
  ) external;
}

interface IFlashLoanSimpleReceiver {
  function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);
  function POOL() external view returns (IPool);
  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
  ) external returns (bool);
}

abstract contract Ownable {
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  address private _owner;
  constructor() { _transferOwnership(msg.sender); }
  modifier onlyOwner() { require(owner() == msg.sender, "Ownable: caller is not the owner"); _; }
  function owner() public view returns (address) { return _owner; }
  function _transferOwnership(address newOwner) internal {
    address old = _owner; _owner = newOwner; emit OwnershipTransferred(old, newOwner);
  }
}

abstract contract ReentrancyGuard { uint256 private _locked; modifier nonReentrant(){ require(_locked==0, "REENTER"); _locked=1; _; _locked=0; } }

contract FlashArbitrageur is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
  struct Swap { address target; bytes data; uint256 value; }

  IPool public immutable override POOL;
  IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;

  event ProfitRealized(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profitSent);

  error NotPool();
  error DeadlineExpired();
  error Unprofitable();

  modifier onlyPool() { if (msg.sender != address(POOL)) revert NotPool(); _; }

  constructor(address addressesProvider) {
    IPoolAddressesProvider provider = IPoolAddressesProvider(addressesProvider);
    ADDRESSES_PROVIDER = provider;
    POOL = IPool(provider.getPool());
  }

  // Entry point from off-chain bot to initiate a flash arbitrage
  function initiateFlashArb(
    address asset,
    uint256 amount,
    Swap[] calldata swaps,
    uint256 deadline
  ) external onlyOwner nonReentrant {
    if (block.timestamp > deadline) revert DeadlineExpired();
    bytes memory params = abi.encode(swaps, deadline);
    POOL.flashLoanSimple(address(this), asset, amount, params, 0);
  }

  // Aave V3 callback where the borrowed funds are available
  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address /*initiator*/,
    bytes calldata params
  ) external override onlyPool nonReentrant returns (bool) {
    (Swap[] memory swaps, uint256 deadline) = abi.decode(params, (Swap[], uint256));
    if (block.timestamp > deadline) revert DeadlineExpired();

    // Execute arbitrary sequence of DEX calls (e.g., Uniswap, Sushi, Curve, Balancer)
    unchecked {
      for (uint256 i = 0; i < swaps.length; i++) {
        (bool ok, bytes memory ret) = swaps[i].target.call{value: swaps[i].value}(swaps[i].data);
        if (!ok) {
          // Bubble up revert data if present
          if (ret.length > 0) assembly { revert(add(ret, 32), mload(ret)) }
          revert("DEX call failed");
        }
      }
    }

    // Verify profitability strictly
    uint256 balance = IERC20(asset).balanceOf(address(this));
    uint256 debt = amount + premium;
    if (balance <= debt) revert Unprofitable();

    // Approve and repay
    require(IERC20(asset).approve(address(POOL), debt), "Approve failed");

    // Send profit to owner immediately
    uint256 profit = balance - debt;
    require(IERC20(asset).transfer(owner(), profit), "Profit transfer failed");

    emit ProfitRealized(asset, amount, premium, profit);
    return true; // Aave will pull the repayment via allowance
  }

  receive() external payable {}
}
