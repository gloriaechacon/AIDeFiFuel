// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IERC20.sol";

interface ISimulatedLiquidityPool {
    function deposit(uint256) external;
    function withdraw(uint256) external;
    function balances(address) external view returns (uint256);
}

contract LiquidityPoolStrategy {
    address public immutable vault;
    IERC20 public immutable usdc;
    ISimulatedLiquidityPool public immutable pool;

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    constructor(address _vault, address _usdc, address _pool) {
        vault = _vault;
        usdc = IERC20(_usdc);
        pool = ISimulatedLiquidityPool(_pool);
    }

    function totalAssets() external view returns (uint256) {
        return pool.balances(address(this));
    }

    function depositFromVault(uint256 amount) external onlyVault {
        usdc.transferFrom(vault, address(this), amount);
        usdc.approve(address(pool), amount);
        pool.deposit(amount);
    }

    function withdrawToVault(uint256 amount) external onlyVault {
        pool.withdraw(amount);
        usdc.transfer(vault, amount);
    }
}
