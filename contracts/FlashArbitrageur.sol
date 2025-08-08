// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import "@aave/core-v3/contracts/interfaces/IFlashLoanSimpleReceiver.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FlashArbitrageur is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    address private constant SWAP_ROUTER = 0xdef1c0ded9bec7f1a1670819833240f027b25eff;

    event ProfitRealized(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 premium,
        uint256 profitSent
    );

    constructor(address _provider) Ownable(msg.sender) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_provider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
    }

    function executeArbitrage(
        address asset,
        uint256 amount,
        bytes memory params
    ) external onlyOwner nonReentrant {
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0
        );
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(
            msg.sender == address(POOL),
            "Caller must be the Aave V3 Pool"
        );
        require(
            initiator == address(this),
            "Initiator must be this contract"
        );

        uint256 amountOwed = amount + premium;

        IERC20(asset).approve(SWAP_ROUTER, amount);

        (bool success, ) = SWAP_ROUTER.call(params);
        require(success, "Arbitrage swaps failed");

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= amountOwed, "Insufficient funds to repay loan");

        uint256 profit = balanceAfter - amountOwed;

        IERC20(asset).approve(address(POOL), amountOwed);
        POOL.repay(asset, amountOwed, 1, address(this));

        if (profit > 0) {
            IERC20(asset).transfer(owner(), profit);
            emit ProfitRealized(asset, amount, premium, profit);
        }

        return true;
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        IERC20(token).transfer(owner(), balance);
    }

    receive() external payable {}
}

