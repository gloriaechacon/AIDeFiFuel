// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/ExpenseVault.sol";
import "../src/SimulatedLiquidityPool.sol";
import "../src/LiquidityPoolStrategy.sol";


/*//////////////////////////////////////////////////////////////
                        MOCK USDC
//////////////////////////////////////////////////////////////*/
contract MockUSDC {
    string public name = "MockUSDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/*//////////////////////////////////////////////////////////////
                    MOCK STRATEGY
//////////////////////////////////////////////////////////////*/
contract MockStrategy {
    MockUSDC public usdc;
    address public vault;

    constructor(address _usdc, address _vault) {
        usdc = MockUSDC(_usdc);
        vault = _vault;
    }

    function totalAssets() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function depositFromVault(uint256 amount) external {
        require(msg.sender == vault, "only vault");
        usdc.transferFrom(vault, address(this), amount);
    }

    function withdrawToVault(uint256 amount) external {
        require(msg.sender == vault, "only vault");
        require(usdc.balanceOf(address(this)) >= amount, "insufficient strategy balance");
        usdc.transfer(vault, amount);
    }
}

/*//////////////////////////////////////////////////////////////
                    TEST CONTRACT
//////////////////////////////////////////////////////////////*/
contract ExpenseVaultTest is Test {
    MockUSDC usdc;
    ExpenseVault vault;
    MockStrategy strategy;

    uint256 ownerPk;
    address owner;
    address spender = address(0xB0B);
    address merchant = address(0xCAFE);

    function setUp() public {
        ownerPk = 0xA11CE; // deterministic test key
        owner = vm.addr(ownerPk);
        usdc = new MockUSDC();
        vault = new ExpenseVault(address(usdc));
        strategy = new MockStrategy(address(usdc), address(vault));

        // Give owner 100 USDC
        usdc.mint(owner, 100e6);

        // Owner deposits 50 USDC
        vm.startPrank(owner);
        usdc.approve(address(vault), 50e6);
        vault.deposit(50e6);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        BASIC TESTS
    //////////////////////////////////////////////////////////////*/

    function testDepositMintShares() public {
        assertEq(vault.balanceOf(owner), 50e6);
        assertEq(vault.totalSupply(), 50e6);
        assertEq(vault.totalAssets(), 50e6);
    }

    function testWithdraw() public {
        vm.startPrank(owner);
        vault.withdraw(10e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(owner), 60e6);
        assertEq(vault.balanceOf(owner), 40e6);
    }

    /*//////////////////////////////////////////////////////////////
                        POLICY TESTS
    //////////////////////////////////////////////////////////////*/

    function testSpendWithPolicyWhitelist() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 20e6, 40e6, true);
        vault.setMerchantAllowed(spender, merchant, true);
        vm.stopPrank();

        vm.prank(spender);
        vault.spend(owner, merchant, 12e6);

        assertEq(usdc.balanceOf(merchant), 12e6);
        assertTrue(vault.balanceOf(owner) < 50e6);
    }

    function testSpendFailsIfMerchantNotAllowed() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 20e6, 40e6, true);
        vm.stopPrank();

        vm.prank(spender);
        vm.expectRevert("merchant not allowed");
        vault.spend(owner, merchant, 1e6);
    }

    function testSpendFailsIfExceedsMaxPerTx() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 5e6, 40e6, false);
        vm.stopPrank();

        vm.prank(spender);
        vm.expectRevert("exceeds maxPerTx");
        vault.spend(owner, merchant, 6e6);
    }

    function testSpendFailsIfExceedsDailyLimit() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 30e6, 35e6, false);
        vm.stopPrank();

        vm.prank(spender);
        vault.spend(owner, merchant, 20e6);

        vm.prank(spender);
        vm.expectRevert("exceeds dailyLimit");
        vault.spend(owner, merchant, 16e6);
    }

    /*//////////////////////////////////////////////////////////////
                    STRATEGY INTEGRATION TESTS
    //////////////////////////////////////////////////////////////*/

    function testSetStrategyAndRebalance() public {
        vm.prank(vault.governance());
        vault.setStrategy(address(strategy));

        uint256 vaultBalBefore = usdc.balanceOf(address(vault));

        vm.prank(vault.governance());
        vault.rebalance();

        uint256 vaultBalAfter = usdc.balanceOf(address(vault));
        uint256 stratBal = usdc.balanceOf(address(strategy));

        assertTrue(stratBal > 0);
        assertTrue(vaultBalAfter < vaultBalBefore);
        assertEq(vault.totalAssets(), 50e6);
    }

    function testWithdrawPullsFromStrategy() public {
        vm.prank(vault.governance());
        vault.setStrategy(address(strategy));

        vm.prank(vault.governance());
        vault.rebalance();

        uint256 shares = vault.balanceOf(owner);

        vm.startPrank(owner);
        vault.withdraw(shares);
        vm.stopPrank();

        assertEq(usdc.balanceOf(owner), 100e6);
        assertEq(vault.totalAssets(), 0);
        assertEq(usdc.balanceOf(address(strategy)), 0);
    }

    function testVaultWithSimulatedLiquidityPool() public {
    // Deploy pool with 5% APY
    SimulatedLiquidityPool pool =
        new SimulatedLiquidityPool(address(usdc), 500);

    LiquidityPoolStrategy lpStrategy =
        new LiquidityPoolStrategy(
            address(vault),
            address(usdc),
            address(pool)
        );

    // Set strategy
    vm.prank(vault.governance());
    vault.setStrategy(address(lpStrategy));

    // Rebalance into pool
    vm.prank(vault.governance());
    vault.rebalance();

    uint256 invested = pool.balances(address(lpStrategy));
    assertTrue(invested > 0);

    // Warp time 6 months
    vm.warp(block.timestamp + 365 days);

    // Trigger interest accrual
    pool.accrueInterest();

    uint256 afterYield = pool.balances(address(lpStrategy));
    assertTrue(afterYield > invested);

    // Withdraw everything
    uint256 shares = vault.balanceOf(owner);

    vm.startPrank(owner);
    vault.withdraw(shares);
    vm.stopPrank();

    assertTrue(usdc.balanceOf(owner) > 100e6);

    }

    function testOffchainPolicyAndMerchantPermitThenSpend() public {
    // 1) Owner signs policy
    uint256 deadline = block.timestamp + 1 days;
    uint256 nonce1 = vault.nonces(owner);

    bytes32 structHashPolicy = keccak256(
        abi.encode(
            vault.SET_POLICY_TYPEHASH(),
            owner,
            spender,
            true,      // enabled
            20e6,      // maxPerTx
            40e6,      // dailyLimit
            true,      // enforce whitelist
            nonce1,
            deadline
        )
    );

    bytes32 digest1 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHashPolicy));
    (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerPk, digest1);

    // Robô (ou qualquer address) submits the signature on-chain:
    vm.prank(spender);
    vault.setPolicyWithSig(owner, spender, true, 20e6, 40e6, true, deadline, v1, r1, s1);

    // 2) Owner signs merchant allow
    uint256 nonce2 = vault.nonces(owner);

    bytes32 structHashMerchant = keccak256(
        abi.encode(
            vault.SET_MERCHANT_TYPEHASH(),
            owner,
            spender,
            merchant,
            true,
            nonce2,
            deadline
        )
    );

    bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHashMerchant));
    (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(ownerPk, digest2);

    vm.prank(spender);
    vault.setMerchantAllowedWithSig(owner, spender, merchant, true, deadline, v2, r2, s2);

    // 3) Spender can now spend without owner's signature
    vm.prank(spender);
    vault.spend(owner, merchant, 12e6);

    assertEq(usdc.balanceOf(merchant), 12e6);
    }


}

