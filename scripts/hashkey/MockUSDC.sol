// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockUSDC for OpenAgentPay × HashKey Chain Testnet demo
 * @notice 自包含、零依赖的 mock USDC 实现，包含完整 EIP-3009 transferWithAuthorization
 *
 * 设计目的：
 *   - 在 HashKey Chain Testnet（chainId 133）上演示 x402 协议
 *   - 完全兼容 Coinbase x402 Facilitator 的 EIP-3009 验签逻辑
 *   - decimals = 6（与 USDC 一致）
 *   - 任何人可以 mint（仅限 testnet 演示，production 应限制 owner）
 *
 * 标准对齐：
 *   - ERC20:    https://eips.ethereum.org/EIPS/eip-20
 *   - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
 *   - EIP-712:  https://eips.ethereum.org/EIPS/eip-712
 *
 * @author OpenAgentPay (https://github.com/neosun100/openagentpay)
 */
contract MockUSDC {
    // ===== ERC20 =====
    string public constant name = "Mock USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ===== EIP-712 / EIP-3009 =====

    // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;

    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice authorizer => nonce => used?
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // ===== Constructor =====
    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes("2")),         // version "2" — Circle USDC uses "2"
                block.chainid,
                address(this)
            )
        );
    }

    // ===== Faucet (testnet only — anyone can mint) =====
    /// @notice 任意地址可以给任意账户 mint，仅限 testnet 演示
    function mint(address to, uint256 amount) external {
        require(to != address(0), "MockUSDC: mint to zero");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    // ===== ERC20 =====
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "MockUSDC: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "MockUSDC: to zero");
        require(balanceOf[from] >= value, "MockUSDC: balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ===== EIP-3009 =====

    /**
     * @notice 用 EIP-712 签名授权一笔转账（任何人可以代付 gas 上链）
     * @dev 这是 x402 协议的核心。Facilitator 拿到 (from 的) 签名后调用此函数，
     *      gas 由 Facilitator 付，资金从 from 转到 to。
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "MockUSDC: too early");
        require(block.timestamp < validBefore, "MockUSDC: expired");
        require(!authorizationState[from][nonce], "MockUSDC: nonce used");

        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == from, "MockUSDC: bad sig");

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    /// @notice 取消一个未使用的授权（gas-less cancellation 通过签名）
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!authorizationState[authorizer][nonce], "MockUSDC: nonce used");
        bytes32 structHash = keccak256(
            abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == authorizer, "MockUSDC: bad sig");
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }
}
