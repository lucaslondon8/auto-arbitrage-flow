// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// --- FLATTENED DEPENDENCIES ---
// All required interfaces and contracts from Aave and OpenZeppelin are included below.

// From: @aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

// From: @aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol
interface IPoolAddressesProvider {
    event PoolUpdated(address indexed newPool);
    event PoolAddressesProviderUpdated(address indexed newPoolAddressesProvider);
    event ACLAdminUpdated(address indexed newAclAdmin);
    event OwnerUpdated(address indexed newOwner);
    function getPool() external view returns (address);
}

// From: @aave/core-v3/contracts/interfaces/IPool.sol
interface IPool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
}

// From: @aave/core-v3/contracts/interfaces/IFlashLoanSimpleReceiver.sol
interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);
    function POOL() external view returns (IPool);
}

// From: @openzeppelin/contracts/utils/Context.sol
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }
}

// From: @openzeppelin/contracts/access/Ownable.sol
abstract contract Ownable is Context {
    address private _owner;
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    constructor(address initialOwner) {
        _transferOwnership(initialOwner);
    }
    function owner() public view virtual returns (address) {
        return _owner;
    }
    modifier onlyOwner() {
        _checkOwner();
        _;
    }
    function _checkOwner() internal view virtual {
        require(owner() == _msgSender(), "Ownable: caller is not the owner");
    }
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }
    function transferOwnership(address newOwner) public virtual onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        _transferOwnership(newOwner);
    }
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

// From: @openzeppelin/contracts/utils/ReentrancyGuard.sol
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;
    constructor() {
        _status = _NOT_ENTERED;
    }
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }
    function _nonReentrantBefore() private {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
    }
    function _nonReentrantAfter() private {
        _status = _NOT_ENTERED;
    }
}

// --- MAIN CONTRACT ---

contract FlashArbitrageur is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;
    address private constant SWAP_ROUTER = 0xDef1C0ded9bec7F1a1670819833240f027b25EfF;

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

