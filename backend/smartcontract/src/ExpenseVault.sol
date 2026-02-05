// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IERC20.sol";

abstract contract ReentrancyGuard {
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrancy");
        _locked = 2;
        _;
        _locked = 1;
    }
}

interface IVaultStrategy {
    function totalAssets() external view returns (uint256);
    function depositFromVault(uint256 amount) external;
    function withdrawToVault(uint256 amount) external;
}

/**
 * ExpenseVault
 * - ERC4626-like shares (minimal)
 * - Delegated spend via policies (spender can spend owner's funds)
 * - Strategy plug-in for yield (rebalance pushes idle funds; pulls back for withdrawals/spends)
 * - Off-chain configuration via EIP-712 signatures (owner signs once; spender submits tx)
 */
contract ExpenseVault is ReentrancyGuard {
    IERC20 public immutable token; // USDC-like (6 decimals)

    // --- Governance / Strategy ---
    address public governance;
    address public strategy;

    // Reserve kept in vault (basis points). Example: 2000 = 20%
    uint256 public reserveBps = 2000;
    uint256 public constant BPS = 10_000;

    // Shares accounting
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf; // shares per user

    // --- Policy layer ---
    struct Policy {
        bool enabled;
        bool enforceMerchantWhitelist;
        uint256 maxPerTx;   // 20e6 => 20 USDC
        uint256 dailyLimit; // 60e6 => 60 USDC/day
    }

    // owner => spender => policy
    mapping(address => mapping(address => Policy)) public policyOf;

    // owner => spender => merchant => allowed
    mapping(address => mapping(address => mapping(address => bool))) public merchantAllowed;

    // owner => spender => dayIndex => spentAmount
    mapping(address => mapping(address => mapping(uint256 => uint256))) public spentPerDay;

    // --- EIP-712 nonces ---
    mapping(address => uint256) public nonces;

    // --- EIP-712 domain ---
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ExpenseVault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    // Typehashes (public for integrators/tests)
    bytes32 public constant SET_POLICY_TYPEHASH =
        keccak256(
            "SetPolicy(address owner,address spender,bool enabled,uint256 maxPerTx,uint256 dailyLimit,bool enforceMerchantWhitelist,uint256 nonce,uint256 deadline)"
        );

    bytes32 public constant SET_MERCHANT_TYPEHASH =
        keccak256(
            "SetMerchant(address owner,address spender,address merchant,bool allowed,uint256 nonce,uint256 deadline)"
        );

    // --- Events ---
    event Deposit(address indexed owner, uint256 amount, uint256 sharesMinted);
    event Withdraw(address indexed owner, uint256 sharesBurned, uint256 amount);

    event GovernanceUpdated(address indexed oldGov, address indexed newGov);
    event StrategySet(address indexed strategy);
    event ReserveBpsSet(uint256 reserveBps);

    event PolicySet(
        address indexed owner,
        address indexed spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    );

    event MerchantAllowedSet(
        address indexed owner,
        address indexed spender,
        address indexed merchant,
        bool allowed
    );

    event Spent(
        address indexed owner,
        address indexed spender,
        address indexed merchant,
        uint256 amount,
        uint256 sharesBurned,
        uint256 dayIndex
    );

    modifier onlyGovernance() {
        require(msg.sender == governance, "only governance");
        _;
    }

    constructor(address _token) {
        token = IERC20(_token);
        governance = msg.sender;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    // -----------------------
    // Views
    // -----------------------

    function totalAssets() public view returns (uint256) {
        uint256 vaultBal = token.balanceOf(address(this));
        if (strategy == address(0)) return vaultBal;
        return vaultBal + IVaultStrategy(strategy).totalAssets();
    }

    function vaultBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // -----------------------
    // Governance / Strategy
    // -----------------------

    function setGovernance(address newGov) external onlyGovernance {
        require(newGov != address(0), "bad gov");
        emit GovernanceUpdated(governance, newGov);
        governance = newGov;
    }

    function setReserveBps(uint256 _reserveBps) external onlyGovernance {
        require(_reserveBps <= BPS, "bad bps");
        reserveBps = _reserveBps;
        emit ReserveBpsSet(_reserveBps);
    }

    function setStrategy(address _strategy) external onlyGovernance {
        // Optional: allow setting to zero (disable strategy)
        strategy = _strategy;
        emit StrategySet(_strategy);
    }

    /**
     * Rebalance: push idle funds above reserve into strategy.
     * Keeps reserveBps of total assets in the vault (liquid for spend/withdraw).
     */
    function rebalance() external onlyGovernance nonReentrant {
        if (strategy == address(0)) return;

        uint256 ta = totalAssets();
        if (ta == 0) return;

        uint256 targetReserve = (ta * reserveBps) / BPS;
        uint256 currentVault = token.balanceOf(address(this));

        if (currentVault > targetReserve) {
            uint256 toInvest = currentVault - targetReserve;

            // move to strategy via transferFrom(vault, strategy) inside strategy.depositFromVault()
            // Strategy expects allowance from vault
            require(token.approve(strategy, toInvest), "approve failed");
            IVaultStrategy(strategy).depositFromVault(toInvest);
        }
    }

    // -----------------------
    // Shares (ERC4626-like)
    // -----------------------

    function _mint(address _to, uint256 _shares) private {
        totalSupply += _shares;
        balanceOf[_to] += _shares;
    }

    function _burn(address _from, uint256 _shares) private {
        balanceOf[_from] -= _shares;
        totalSupply -= _shares;
    }

    function deposit(uint256 _amount) external nonReentrant {
        require(_amount > 0, "amount=0");

        uint256 shares;
        uint256 taBefore = totalAssets();

        if (totalSupply == 0) {
            shares = _amount;
        } else {
            // shares = amount * totalSupply / totalAssetsBefore
            shares = (_amount * totalSupply) / taBefore;
        }

        _mint(msg.sender, shares);
        require(token.transferFrom(msg.sender, address(this), _amount), "transferFrom failed");

        emit Deposit(msg.sender, _amount, shares);
    }

    function withdraw(uint256 _shares) external nonReentrant {
        require(_shares > 0, "shares=0");
        require(totalSupply > 0, "empty");

        uint256 ta = totalAssets();
        uint256 amount = (_shares * ta) / totalSupply;

        _burn(msg.sender, _shares);

        _ensureVaultLiquidity(amount);
        require(token.transfer(msg.sender, amount), "transfer failed");

        emit Withdraw(msg.sender, _shares, amount);
    }

    function _ensureVaultLiquidity(uint256 needed) internal {
        uint256 currentVault = token.balanceOf(address(this));
        if (currentVault >= needed) return;

        uint256 missing = needed - currentVault;
        if (strategy == address(0)) revert("insufficient liquidity");

        // Pull from strategy
        IVaultStrategy(strategy).withdrawToVault(missing);

        // If strategy couldn't provide, transfer will fail later; we keep it simple.
    }

    // -----------------------
    // Policy management (on-chain)
    // -----------------------

    function setPolicy(
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    ) external {
        _setPolicy(msg.sender, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function setMerchantAllowed(address spender, address merchant, bool allowed) external {
        _setMerchantAllowed(msg.sender, spender, merchant, allowed);
    }

    function _setPolicy(
        address owner,
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    ) internal {
        require(spender != address(0), "bad spender");
        require(maxPerTx > 0, "maxPerTx=0");
        require(dailyLimit >= maxPerTx, "daily<perTx");

        policyOf[owner][spender] = Policy({
            enabled: enabled,
            enforceMerchantWhitelist: enforceMerchantWhitelist,
            maxPerTx: maxPerTx,
            dailyLimit: dailyLimit
        });

        emit PolicySet(owner, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function _setMerchantAllowed(address owner, address spender, address merchant, bool allowed) internal {
        require(spender != address(0), "bad spender");
        require(merchant != address(0), "bad merchant");

        merchantAllowed[owner][spender][merchant] = allowed;
        emit MerchantAllowedSet(owner, spender, merchant, allowed);
    }

    // -----------------------
    // Policy management (off-chain signatures / EIP-712)
    // -----------------------

    function setPolicyWithSig(
        address owner,
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "bad owner");
        require(block.timestamp <= deadline, "expired");

        uint256 nonce = nonces[owner]++;

        bytes32 structHash = keccak256(
            abi.encode(
                SET_POLICY_TYPEHASH,
                owner,
                spender,
                enabled,
                maxPerTx,
                dailyLimit,
                enforceMerchantWhitelist,
                nonce,
                deadline
            )
        );

        _verifySig(owner, structHash, v, r, s);
        _setPolicy(owner, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function setMerchantAllowedWithSig(
        address owner,
        address spender,
        address merchant,
        bool allowed,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "bad owner");
        require(block.timestamp <= deadline, "expired");

        uint256 nonce = nonces[owner]++;

        bytes32 structHash = keccak256(
            abi.encode(
                SET_MERCHANT_TYPEHASH,
                owner,
                spender,
                merchant,
                allowed,
                nonce,
                deadline
            )
        );

        _verifySig(owner, structHash, v, r, s);
        _setMerchantAllowed(owner, spender, merchant, allowed);
    }

    function _verifySig(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == signer, "bad sig");
    }

    // -----------------------
    // Automated spend
    // -----------------------

    function spend(address owner, address merchant, uint256 amount) external nonReentrant {
        require(owner != address(0), "bad owner");
        require(merchant != address(0), "bad merchant");
        require(amount > 0, "amount=0");

        Policy memory p = policyOf[owner][msg.sender];
        require(p.enabled, "policy disabled");
        require(amount <= p.maxPerTx, "exceeds maxPerTx");

        if (p.enforceMerchantWhitelist) {
            require(merchantAllowed[owner][msg.sender][merchant], "merchant not allowed");
        }

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 spentToday = spentPerDay[owner][msg.sender][dayIndex];
        require(spentToday + amount <= p.dailyLimit, "exceeds dailyLimit");

        // Update daily spent first
        spentPerDay[owner][msg.sender][dayIndex] = spentToday + amount;

        // sharesToBurn = ceil(amount * totalSupply / totalAssets)
        uint256 ta = totalAssets();
        require(ta > 0 && totalSupply > 0, "empty vault");

        uint256 sharesToBurn = (amount * totalSupply) / ta;
        if ((sharesToBurn * ta) / totalSupply < amount) {
            sharesToBurn += 1;
        }

        require(balanceOf[owner] >= sharesToBurn, "insufficient shares");
        _burn(owner, sharesToBurn);

        _ensureVaultLiquidity(amount);
        require(token.transfer(merchant, amount), "transfer failed");

        emit Spent(owner, msg.sender, merchant, amount, sharesToBurn, dayIndex);
    }
}

