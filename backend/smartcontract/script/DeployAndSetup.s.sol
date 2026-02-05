// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/ExpenseVault.sol";
import "../src/SimulatedLiquidityPool.sol";
import "../src/LiquidityPoolStrategy.sol";

// Minimal mintable USDC mock for Base Sepolia demo.
// If you already have a mock in src/, you can remove this and import yours.
contract MintableMockUSDC {
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

contract DeployAndSetup is Script {
    // Hardcode the addresses you gave (safe — public addresses only)
    address constant OWNER_ADDRESS   = 0x042E8214DCfc8648B7b98f173C523611274e81C9;
    address constant SPENDER_ADDRESS = 0x26BA8Aa82bFFbEB099255040Ad83fdc8A9B0E2Db;
    address constant MERCHANT_ADDRESS= 0xDf3C4a3634b88e42fE9Ee652619F0a59bC747174;

    function run() external {
        // Env:
        // DEPLOYER_PRIVATE_KEY: the EOA that deploys & broadcasts transactions.
        // OWNER_PRIVATE_KEY: owner key used ONLY to create signatures (and may be same as deployer).
        // NOTE: never commit .env
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 ownerPk    = vm.envUint("OWNER_PRIVATE_KEY");

        address deployer = vm.addr(deployerPk);
        address owner    = vm.addr(ownerPk);

        require(owner == OWNER_ADDRESS, "OWNER_PRIVATE_KEY does not match OWNER_ADDRESS");

        // --- Config ---
        uint256 annualRateBps = 500; // 5% APY simulated
        uint256 mintAmount    = 1_000e6; // 1,000 USDC (6 decimals)
        uint256 depositAmount = 200e6;   // deposit 200 USDC

        // Policy params (USDC 6 decimals)
        uint256 maxPerTx   = 20e6;
        uint256 dailyLimit = 40e6;
        bool whitelist     = true;

        uint256 deadline = block.timestamp + 7 days;

        vm.startBroadcast(deployerPk);

        // 1) Deploy mock USDC
        MintableMockUSDC usdc = new MintableMockUSDC();

        // 2) Deploy vault
        ExpenseVault vault = new ExpenseVault(address(usdc));

        // 3) Deploy simulated pool
        SimulatedLiquidityPool pool = new SimulatedLiquidityPool(address(usdc), annualRateBps);

        // 4) Deploy strategy
        LiquidityPoolStrategy strategy = new LiquidityPoolStrategy(address(vault), address(usdc), address(pool));

        // 5) Wire strategy
        // governance is deployer (constructor sets governance=msg.sender)
        // If you want governance == OWNER, you can later call setGovernance(OWNER_ADDRESS).
        vault.setStrategy(address(strategy));

        // 6) Fund owner with USDC and deposit
        usdc.mint(OWNER_ADDRESS, mintAmount);

        // Approve + deposit must be sent from OWNER.
        // We do it by broadcasting as deployer only if deployer==owner.
        // If deployer != owner, skip deposit here and do it via owner wallet manually.
        if (deployer == OWNER_ADDRESS) {
            usdc.approve(address(vault), depositAmount);
            vault.deposit(depositAmount);
            vault.rebalance();
        }

        // 7) Off-chain signatures (EIP-712) + on-chain submit (spender can submit, but anyone can submit)
        // We'll submit as deployer for simplicity.
        // a) Sign SetPolicy
        uint256 nonce1 = vault.nonces(OWNER_ADDRESS);

        bytes32 structHash1 = keccak256(
            abi.encode(
                vault.SET_POLICY_TYPEHASH(),
                OWNER_ADDRESS,
                SPENDER_ADDRESS,
                true,
                maxPerTx,
                dailyLimit,
                whitelist,
                nonce1,
                deadline
            )
        );

        bytes32 digest1 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash1));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerPk, digest1);

        vault.setPolicyWithSig(
            OWNER_ADDRESS,
            SPENDER_ADDRESS,
            true,
            maxPerTx,
            dailyLimit,
            whitelist,
            deadline,
            v1, r1, s1
        );

        // b) Sign SetMerchantAllowed (only if whitelist=true)
        if (whitelist) {
            uint256 nonce2 = vault.nonces(OWNER_ADDRESS);

            bytes32 structHash2 = keccak256(
                abi.encode(
                    vault.SET_MERCHANT_TYPEHASH(),
                    OWNER_ADDRESS,
                    SPENDER_ADDRESS,
                    MERCHANT_ADDRESS,
                    true,
                    nonce2,
                    deadline
                )
            );

            bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash2));
            (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(ownerPk, digest2);

            vault.setMerchantAllowedWithSig(
                OWNER_ADDRESS,
                SPENDER_ADDRESS,
                MERCHANT_ADDRESS,
                true,
                deadline,
                v2, r2, s2
            );
        }

        // Optional: set governance to OWNER (if you want)
        // vault.setGovernance(OWNER_ADDRESS);

        vm.stopBroadcast();

        // --- Logs ---
        console2.log("Deployer:", deployer);
        console2.log("OWNER:", OWNER_ADDRESS);
        console2.log("SPENDER:", SPENDER_ADDRESS);
        console2.log("MERCHANT:", MERCHANT_ADDRESS);

        console2.log("MockUSDC:", address(usdc));
        console2.log("ExpenseVault:", address(vault));
        console2.log("SimulatedLiquidityPool:", address(pool));
        console2.log("LiquidityPoolStrategy:", address(strategy));
    }
}

