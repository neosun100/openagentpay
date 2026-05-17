"""
部署 MockUSDC 到 HashKey Chain Testnet
========================================

完整流程：
  1. 加载 .env.local 里的 Agent wallet private key
  2. 连接 HashKey Chain Testnet (chainId 133)
  3. 检查余额（HSK 用作 gas）
  4. 部署 MockUSDC.sol（已用 solc 编译过）
  5. mint 1000 USDC 给 Agent wallet 自己
  6. 把合约地址追加写入 .env.local
  7. 输出 Blockscout 链接

Run:
    cd ~/Code/openagentpay/scripts/hashkey
    python3 deploy.py

License: Apache-2.0
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from eth_account import Account
from web3 import Web3


# ----------------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------------
def load_env_local(path: Path) -> dict[str, str]:
    """读取 .env.local 为 dict（不依赖 dotenv 包）。"""
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


def append_env_local(path: Path, kv: dict[str, str]) -> None:
    """把新 KV pair 追加到 .env.local。如果 key 已存在，更新它。"""
    existing = load_env_local(path)
    existing.update(kv)
    lines = path.read_text().splitlines() if path.exists() else []
    # 简单做法：只追加新 key（不更新已有的）
    new_keys = [k for k in kv if k not in {ln.split("=", 1)[0].strip() for ln in lines if "=" in ln}]
    if new_keys:
        with path.open("a") as f:
            f.write("\n# --- Deployed contracts (auto-appended " + time.strftime("%Y-%m-%d %H:%M:%S") + ") ---\n")
            for k in new_keys:
                f.write(f"{k}={kv[k]}\n")


def hr() -> None:
    print("=" * 70)


# ----------------------------------------------------------------------------
#  Main
# ----------------------------------------------------------------------------
def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent.parent  # ~/Code/openagentpay
    env_path = repo_root / ".env.local"
    build_dir = Path(__file__).resolve().parent / "build"

    # ---- 1. Load env
    env = load_env_local(env_path)
    pk = env.get("HASHKEY_TESTNET_AGENT_PRIVATE_KEY")
    if not pk:
        print(f"❌ 找不到 HASHKEY_TESTNET_AGENT_PRIVATE_KEY in {env_path}")
        return 2
    rpc_url = env.get("HASHKEY_RPC_URL", "https://testnet.hsk.xyz")
    chain_id = int(env.get("HASHKEY_CHAIN_ID", "133"))
    explorer = env.get("HASHKEY_EXPLORER_URL", "https://testnet-explorer.hsk.xyz")

    # ---- 2. Setup web3
    hr()
    print("🌐 OpenAgentPay × HashKey Chain Testnet — Deploy MockUSDC")
    hr()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        print(f"❌ 无法连接 RPC: {rpc_url}")
        return 3
    print(f"✅ Connected to {rpc_url}")
    print(f"   Chain ID: {chain_id}")
    print(f"   Latest block: {w3.eth.block_number:,}")
    print(f"   Gas price:    {w3.eth.gas_price:,} wei ({w3.eth.gas_price / 1e9:.6f} gwei)")
    print()

    # ---- 3. Load account
    acct = Account.from_key(pk)
    bal_wei = w3.eth.get_balance(acct.address)
    print(f"👛 Agent Wallet: {acct.address}")
    print(f"   HSK balance: {Web3.from_wei(bal_wei, 'ether')} HSK")
    if bal_wei < 10 ** 16:  # < 0.01 HSK
        print(f"   ⚠️  HSK 余额可能不够 gas，去 https://faucet.hsk.xyz/ 多领点")
    print()

    # ---- 4. Load compiled artifacts
    bin_path = build_dir / "MockUSDC.bin"
    abi_path = build_dir / "MockUSDC.abi"
    if not bin_path.exists() or not abi_path.exists():
        print(f"❌ 找不到编译产物 {build_dir}")
        print(f"   先跑：cd {Path(__file__).parent} && solc --bin --abi --optimize -o build --overwrite MockUSDC.sol")
        return 4
    bytecode = "0x" + bin_path.read_text().strip()
    abi = json.loads(abi_path.read_text())
    print(f"📦 Loaded MockUSDC bytecode: {len(bytecode) // 2 - 1} bytes")
    print()

    # ---- 5. Deploy
    print("🚀 Deploying MockUSDC...")
    Contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    nonce = w3.eth.get_transaction_count(acct.address)
    deploy_tx = Contract.constructor().build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "chainId": chain_id,
        "gas": 2_500_000,
        "gasPrice": w3.eth.gas_price,
    })
    signed = acct.sign_transaction(deploy_tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"   Tx hash: {tx_hash.hex()}")
    print(f"   Waiting for confirmation...")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        print(f"❌ Deploy failed; receipt: {receipt}")
        return 5
    contract_address = receipt.contractAddress
    print(f"✅ Deployed!")
    print(f"   Contract:   {contract_address}")
    print(f"   Gas used:   {receipt.gasUsed:,}")
    print(f"   Cost:       {Web3.from_wei(receipt.gasUsed * w3.eth.gas_price, 'ether')} HSK")
    print(f"   Explorer:   {explorer}/address/{contract_address}")
    print(f"   Tx:         {explorer}/tx/0x{tx_hash.hex().lstrip('0x')}")
    print()

    # ---- 6. Verify domain separator
    contract = w3.eth.contract(address=contract_address, abi=abi)
    ds = contract.functions.DOMAIN_SEPARATOR().call().hex()
    name = contract.functions.name().call()
    sym = contract.functions.symbol().call()
    dec = contract.functions.decimals().call()
    print(f"🔐 Contract metadata:")
    print(f"   name:             {name}")
    print(f"   symbol:           {sym}")
    print(f"   decimals:         {dec}")
    print(f"   DOMAIN_SEPARATOR: 0x{ds}")
    print()

    # ---- 7. Mint 1000 USDC to agent wallet
    print("💰 Minting 1000 USDC to Agent Wallet...")
    mint_amount = 1000 * 10 ** dec  # 1000 USDC, 6 decimals = 1_000_000_000
    nonce += 1
    mint_tx = contract.functions.mint(acct.address, mint_amount).build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "chainId": chain_id,
        "gas": 100_000,
        "gasPrice": w3.eth.gas_price,
    })
    signed_mint = acct.sign_transaction(mint_tx)
    mint_hash = w3.eth.send_raw_transaction(signed_mint.raw_transaction)
    mint_receipt = w3.eth.wait_for_transaction_receipt(mint_hash, timeout=60)
    if mint_receipt.status != 1:
        print(f"❌ Mint failed")
        return 6
    bal = contract.functions.balanceOf(acct.address).call()
    print(f"✅ Minted!")
    print(f"   Tx:        {explorer}/tx/0x{mint_hash.hex().lstrip('0x')}")
    print(f"   Balance:   {bal / 10 ** dec} USDC ({bal} atomic units)")
    print()

    # ---- 8. Save to .env.local
    append_env_local(env_path, {
        "HASHKEY_USDC_ADDRESS": contract_address,
        "HASHKEY_USDC_DEPLOY_TX": "0x" + tx_hash.hex().lstrip("0x"),
        "HASHKEY_USDC_DEPLOY_BLOCK": str(receipt.blockNumber),
    })
    print(f"📝 已写入 .env.local:")
    print(f"   HASHKEY_USDC_ADDRESS={contract_address}")
    print()

    hr()
    print("✅ 部署完成。下一步：")
    print(f"   python3 transfer-with-auth.py")
    print(f"   # 这个脚本会跑一笔真实 EIP-3009 transferWithAuthorization 上链")
    hr()
    return 0


if __name__ == "__main__":
    sys.exit(main())
