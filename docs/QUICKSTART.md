# Quickstart — Run the Demo Locally (5 minutes)

> 跑一次 OpenAgentPay × HashKey Chain Testnet demo，看到三 Tab UI + 真实链上结算。

## 前置环境

| 工具 | 版本 | 装法 |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) 或 `brew install node` |
| pnpm | ≥ 11 | `npm install -g pnpm` |
| Python | ≥ 3.10 | macOS 自带 / `brew install python` |
| solc | ≥ 0.8.20 | `brew install solidity`（可选，不重新部署合约不需要）|

## Step 1 — 拿到代码 + 装依赖

```bash
git clone https://github.com/neosun100/openAgentPay
cd openAgentPay
pnpm install
```

## Step 2 — 配置 `.env.local`

如果你还没有 HashKey Chain Testnet 钱包：

```bash
# 生成一个全新的 testnet 钱包（throwaway，无任何价值）
python3 -c "from eth_account import Account; import secrets; \
  a = Account.create(secrets.token_hex(32)); \
  print(f'HASHKEY_TESTNET_AGENT_ADDRESS={a.address}\n\
HASHKEY_TESTNET_AGENT_PRIVATE_KEY={a.key.hex()}')"
```

把输出粘贴到 `.env.local`，再加上链/合约地址（直接复用我们部好的 mock USDC）：

```bash
cat >> .env.local << 'EOF'
# HashKey Chain Testnet
HASHKEY_CHAIN_ID=133
HASHKEY_RPC_URL=https://testnet.hsk.xyz
HASHKEY_EXPLORER_URL=https://testnet-explorer.hsk.xyz
HASHKEY_FAUCET_URL=https://faucet.hsk.xyz/
# Pre-deployed mock USDC (you can reuse this, or run your own deploy.py)
HASHKEY_USDC_ADDRESS=0x0685C487Df4Cc0723Aa828C299686798294E9803
EOF
```

## Step 3 — Faucet 领测试 HSK

打开 https://faucet.hsk.xyz/ ，粘贴 `HASHKEY_TESTNET_AGENT_ADDRESS`，领 0.1 HSK（够跑 100 万次微支付）。

## Step 4 — Mint 1000 mock USDC 到你的钱包

> 如果你想用全新钱包（faucet 后还没 USDC 余额），运行：

```bash
cd scripts/hashkey
solc --bin --abi --optimize -o build --overwrite MockUSDC.sol  # 编译（如果没装 solc 跳过）
python3 deploy.py
```

> 或者**直接复用** Neo 已经部署好的 `0x0685C4...` 合约——但你的钱包需要额外 mint：

```bash
python3 -c "
from web3 import Web3
from eth_account import Account
import os, json
w3 = Web3(Web3.HTTPProvider('https://testnet.hsk.xyz'))
acct = Account.from_key(os.environ['HASHKEY_TESTNET_AGENT_PRIVATE_KEY'])
abi = json.loads(open('scripts/hashkey/build/MockUSDC.abi').read())
c = w3.eth.contract(address='0x0685C487Df4Cc0723Aa828C299686798294E9803', abi=abi)
tx = c.functions.mint(acct.address, 1000_000000).build_transaction({
    'from': acct.address, 'nonce': w3.eth.get_transaction_count(acct.address),
    'chainId': 133, 'gas': 100000, 'gasPrice': w3.eth.gas_price,
})
signed = acct.sign_transaction(tx)
h = w3.eth.send_raw_transaction(signed.raw_transaction)
w3.eth.wait_for_transaction_receipt(h)
print(f'Minted! Tx: 0x{h.hex().lstrip(\"0x\")}')
"
```

## Step 5 — 一键启动 demo

```bash
pnpm demo
```

终端会同时启动：
- **API server** on `http://localhost:8787`
- **Web UI** on `http://localhost:5173`

打开浏览器 → http://localhost:5173 → 看到 OpenAgentPay 三 Tab UI！

---

## 三个 Tab 该怎么玩

### Run Demo (4 步链上结算)

1. 点 Step 1 **Run** → 看到钱包余额（live 链上数据）
2. 点 Step 2 **Run** → 创建 Session（budget $1, 60 分钟）
3. 点 Step 3 **Pay 0.1 USDC** → 等约 5 秒，看到 **真实 tx hash + Blockscout 链接**
4. 点 Step 4 **Run** → 看 session 累计花费

### How It Works (8 步全链路)

点击左侧任一步骤，右侧显示该步骤的 OpenAgentPay 实现细节。重点看 Step 6（EIP-712 签名）和 Step 7（链上 ecrecover）。

### AI Agent (Strands 风格)

3 个预设 prompt：
- "BTC 行情"（免费，纯 mock）
- "ETH 深度分析"（**真上链 0.001 USDC**）
- "减半研报"（**真上链 0.005 USDC**）

每次付费按钮都会触发真实链上交易，余额会扣减。

---

## 跑命令行 smoke test（不开 UI 也能验证）

### Python 版（参考实现）
```bash
cd scripts/hashkey
python3 transfer-with-auth.py
```

### TypeScript 版（用 `@openagentpay/wallet-hashkey` package）
```bash
pnpm smoke:hashkey
```

每跑一次都会真实在 HashKey Chain Testnet 落一笔 1 USDC 转账，链接在 Blockscout 上立刻可查。

---

## 故障排除

### "HASHKEY_TESTNET_AGENT_PRIVATE_KEY missing in .env.local"
你没设 `.env.local`，或私钥没有 `0x` 前缀。回 Step 2。

### Settlement 失败 "RPC error / insufficient funds"
钱包没有 HSK 当 gas。回 Step 3 领 faucet。

### Settlement 失败 "balance"
钱包没有 USDC（mint 没成功）。回 Step 4。

### Vite 启动后白屏
后端 API 没起来，Vite 代理 `/api/*` 失败。检查终端是否两个服务都启动了。

---

## 下一步

- 部署到 AWS：见 `packages/cdk-deploy/`（CDK to Lambda + CloudFront）— Phase H
- 接 Strands Agent：apps/demo-web Tab 3 当前 mock，下一步真接 AgentCore Runtime — Phase I
- 接 Coinbase CDP / Stripe Privy：路径 D 混合方案的另一半 — v0.2
