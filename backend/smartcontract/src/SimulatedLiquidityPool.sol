// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IERC20.sol";

contract SimulatedLiquidityPool {
    IERC20 public immutable usdc;

    uint256 public lastAccrual;
    uint256 public immutable annualRateBps; // e.g. 500 = 5%

    uint256 public index = 1e18; // 1.0
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 private constant WAD = 1e18;

    constructor(address _usdc, uint256 _annualRateBps) {
        usdc = IERC20(_usdc);
        annualRateBps = _annualRateBps;
        lastAccrual = block.timestamp;
    }

    function _totalUnderlying() internal view returns (uint256) {
        // total underlying = totalShares * index
        return (totalShares * index) / WAD;
    }

    /// @notice Accrues interest by increasing the index AND minting yield to the pool (simulation).
    function accrueInterest() public {
        if (totalShares == 0) {
            lastAccrual = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return;

        uint256 underlyingBefore = _totalUnderlying();

        // interest = underlying * rate * time
        uint256 interest =
            (underlyingBefore * annualRateBps * elapsed) /
            (BPS * YEAR);

        // --- Materialize yield for the simulation ---
        // Our MockUSDC has mint(address,uint256). We call it via low-level call
        // so this pool still compiles against IERC20.
        (bool ok, ) = address(usdc).call(
            abi.encodeWithSignature("mint(address,uint256)", address(this), interest)
        );
        require(ok, "mint failed (use mintable token in tests)");

        // Update index so balances() reflect the new underlying
        uint256 underlyingAfter = underlyingBefore + interest;
        index = (underlyingAfter * WAD) / totalShares;

        lastAccrual = block.timestamp;
    }

    function balances(address account) external view returns (uint256) {
        return (sharesOf[account] * index) / WAD;
    }

    function deposit(uint256 amount) external {
        accrueInterest();
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");

        uint256 mintedShares = (amount * WAD) / index;
        require(mintedShares > 0, "mintedShares=0");

        sharesOf[msg.sender] += mintedShares;
        totalShares += mintedShares;
    }

    function withdraw(uint256 amount) external {
        accrueInterest();

        uint256 sharesToBurn = (amount * WAD) / index;
        if ((sharesToBurn * index) / WAD < amount) sharesToBurn += 1;

        require(sharesOf[msg.sender] >= sharesToBurn, "insufficient");
        sharesOf[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;

        require(usdc.transfer(msg.sender, amount), "transfer failed");
    }
}
