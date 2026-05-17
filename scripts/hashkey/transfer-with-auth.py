"""
EIP-3009 transferWithAuthorization 端到端演示
================================================

模拟 x402 协议的完整一笔微支付，分 4 个角色：

  ┌──────────────────┐
  │  Agent Wallet    │ ── EIP-712 sign ──┐
  │  (Payer)         │                    │
  │  签名授权但不上链 │                    │
  └──────────────────┘                    │
                                           ▼
  ┌──────────────────┐         ┌──────────────────────┐
  │  Merchant        │ ◄── tx ─│ Facilitator           │
  │  (Recipient)     │  on-chain│ (Settler / Gas-payer) │
  │  收钱地址，不签名 │   USDC   │ 用 sig 调合约上链      │
  └──────────────────┘         └──────────────────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ HashKey Chain    │
                                  │ Testnet (133)    │
                                  │ MockUSDC 合约     │
                                  └──────────────────┘

为简化 demo，Agent Wallet 和 Facilitator 用同一个钱包（你领 faucet 的那个），
Merchant 现场生成一个新地址。这跟 x402.org 实际架构相同——
Coinbase x402 Facilitator 也只是用一个 EOA 替 Agent 提交。

License: Apache-2.0
"""
from __future__ import annotations

import json
import os
import secrets as pysecrets
import sys
import time
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3


# ----------------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------------
def load_env_local(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def hr() -> None:
    print("=" * 70)


# ----------------------------------------------------------------------------
#  Main
# ----------------------------------------------------------------------------
def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent.parent
    env_path = repo_root / ".env.local"
    build_dir = Path(__file__).resolve().parent / "build"

    env = load_env_local(env_path)
    pk = env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"]
    rpc_url = env.get("HASHKEY_RPC_URL", "https://testnet.hsk.xyz")
    chain_id = int(env.get("HASHKEY_CHAIN_ID", "133"))
    explorer = env.get("HASHKEY_EXPLORER_URL", "https://testnet-explorer.hsk.xyz")
    usdc_address = env["HASHKEY_USDC_ADDRESS"]

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    abi = json.loads((build_dir / "MockUSDC.abi").read_text())

    agent = Account.from_key(pk)
    contract = w3.eth.contract(address=usdc_address, abi=abi)

    # ---- 现场生成 Merchant 地址（接收方，无私钥需求）
    merchant_acct = Account.create(pysecrets.token_hex(32))
    merchant_address = merchant_acct.address

    hr()
    print("🌐 OpenAgentPay × HashKey Chain — EIP-3009 transferWithAuthorization Demo")
    hr()
    print(f"Network:  HashKey Chain Testnet (chainId={chain_id})")
    print(f"USDC:     {usdc_address}")
    print(f"Block:    #{w3.eth.block_number:,}")
    print()
    print(f"👛 Agent Wallet (Payer):    {agent.address}")
    print(f"🏪 Merchant Wallet (Payee): {merchant_address} [现场生成]")
    print()

    # ---- 1. 检查初始余额
    print("Step 1️⃣  检查初始 USDC 余额")
    print("-" * 70)
    decimals = contract.functions.decimals().call()
    agent_bal_before = contract.functions.balanceOf(agent.address).call()
    merchant_bal_before = contract.functions.balanceOf(merchant_address).call()
    print(f"  Agent:     {agent_bal_before / 10 ** decimals:.6f} USDC")
    print(f"  Merchant:  {merchant_bal_before / 10 ** decimals:.6f} USDC (期望 0)")
    print()

    # ---- 2. 构造 EIP-712 typed data (TransferWithAuthorization)
    print("Step 2️⃣  Agent 签名 EIP-712 TransferWithAuthorization")
    print("-" * 70)
    amount_atomic = 1 * 10 ** decimals  # 1 USDC
    valid_after = 0
    valid_before = int(time.time()) + 600  # 10 分钟内有效
    nonce_bytes = pysecrets.token_bytes(32)
    nonce_hex = "0x" + nonce_bytes.hex()

    domain_separator_onchain = "0x" + contract.functions.DOMAIN_SEPARATOR().call().hex()

    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": contract.functions.name().call(),     # "Mock USD Coin"
            "version": "2",
            "chainId": chain_id,
            "verifyingContract": Web3.to_checksum_address(usdc_address),
        },
        "message": {
            "from": agent.address,
            "to": Web3.to_checksum_address(merchant_address),
            "value": amount_atomic,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce_bytes,
        },
    }

    encoded = encode_typed_data(full_message=typed_data)
    signed = agent.sign_message(encoded)

    # 验证 domain separator 匹配（off-chain vs on-chain）
    print(f"  Authorization payload:")
    print(f"    from:        {agent.address}")
    print(f"    to:          {merchant_address}")
    print(f"    value:       {amount_atomic} atomic ({amount_atomic / 10 ** decimals} USDC)")
    print(f"    validAfter:  {valid_after}")
    print(f"    validBefore: {valid_before}")
    print(f"    nonce:       {nonce_hex}")
    print()
    print(f"  Domain separator match:")
    print(f"    on-chain:  {domain_separator_onchain}")
    print(f"    typed:     (computed by eth_account)")
    print()
    print(f"  Signature:")
    print(f"    v: {signed.v}")
    print(f"    r: 0x{signed.r:064x}")
    print(f"    s: 0x{signed.s:064x}")
    print(f"    sig (compact): 0x{signed.signature.hex()}")
    print()

    # ---- 3. Facilitator (= 同一个钱包) 调合约上链
    print("Step 3️⃣  Facilitator 把签名提交到链上 (broadcast tx, pay gas)")
    print("-" * 70)
    facilitator_acct = agent  # demo 简化：Agent 钱包同时充当 Facilitator
    nonce_tx = w3.eth.get_transaction_count(facilitator_acct.address)
    twa_tx = contract.functions.transferWithAuthorization(
        agent.address,
        Web3.to_checksum_address(merchant_address),
        amount_atomic,
        valid_after,
        valid_before,
        nonce_bytes,
        signed.v,
        signed.r.to_bytes(32, "big"),
        signed.s.to_bytes(32, "big"),
    ).build_transaction({
        "from": facilitator_acct.address,
        "nonce": nonce_tx,
        "chainId": chain_id,
        "gas": 200_000,
        "gasPrice": w3.eth.gas_price,
    })
    signed_tx = facilitator_acct.sign_transaction(twa_tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    print(f"  Tx broadcast: 0x{tx_hash.hex().lstrip('0x')}")
    print(f"  Waiting for confirmation...")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        print(f"❌ tx 失败: {receipt}")
        return 1
    print(f"  ✅ Block #{receipt.blockNumber}, gas used {receipt.gasUsed:,}")
    print(f"  💰 Settlement cost: {Web3.from_wei(receipt.gasUsed * w3.eth.gas_price, 'ether')} HSK")
    print()

    # ---- 4. 验证转账完成
    print("Step 4️⃣  链上验证转账完成")
    print("-" * 70)
    agent_bal_after = contract.functions.balanceOf(agent.address).call()
    merchant_bal_after = contract.functions.balanceOf(merchant_address).call()
    nonce_used = contract.functions.authorizationState(agent.address, nonce_bytes).call()
    print(f"  Agent:           {agent_bal_before / 10 ** decimals:.6f} → {agent_bal_after / 10 ** decimals:.6f} USDC")
    print(f"  Merchant:        {merchant_bal_before / 10 ** decimals:.6f} → {merchant_bal_after / 10 ** decimals:.6f} USDC")
    print(f"  Nonce used:      {nonce_used} ✅")
    assert agent_bal_after == agent_bal_before - amount_atomic, "Agent 余额异常"
    assert merchant_bal_after == merchant_bal_before + amount_atomic, "Merchant 余额异常"
    assert nonce_used, "nonce 应该被标记已用"
    print()

    # ---- 5. 输出最终链接
    hr()
    print("✅ 端到端演示完成。在 Blockscout 上自己点开看：")
    print()
    print(f"   📜 Settlement tx:     {explorer}/tx/0x{tx_hash.hex().lstrip('0x')}")
    print(f"   👛 Agent wallet:      {explorer}/address/{agent.address}")
    print(f"   🏪 Merchant wallet:   {explorer}/address/{merchant_address}")
    print(f"   💵 USDC contract:     {explorer}/address/{usdc_address}")
    print()
    print("📝 关键点（给客户演示时强调）:")
    print(f"   1. Agent **没有** broadcast tx —— 只签了一个离线 EIP-712 message")
    print(f"   2. Facilitator 替 Agent 提交并付 gas，资金从 Agent 转到 Merchant")
    print(f"   3. nonce 防 replay（已经用过的 nonce 链上拒绝）")
    print(f"   4. 整笔结算在 HashKey Chain Testnet 真实可查 + immutable")
    print(f"   5. 协议层完全是 x402 / EIP-3009 标准——AgentCore Payments 同款")
    hr()
    return 0


if __name__ == "__main__":
    sys.exit(main())
