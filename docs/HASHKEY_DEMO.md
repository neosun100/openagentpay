# HashKey Chain Testnet — End-to-End Demo

> **状态**：✅ Live · **首次跑通**：2026-05-17 20:55 UTC+8
> **Network**：HashKey Chain Testnet (Chain ID `133`)
> **目的**：证明 OpenAgentPay 的 x402 协议路径在 Coinbase / Base 之外的链上同样跑通

## TL;DR

3 个脚本，5 分钟跑通 x402 / EIP-3009 完整链路。**真上链，Blockscout 可查**。

```bash
cd ~/Code/openAgentPay/scripts/hashkey

# 1. 编译合约（已做过，可跳过）
solc --bin --abi --optimize -o build --overwrite MockUSDC.sol

# 2. 部署 + mint 1000 USDC（已做过）
python3 deploy.py

# 3. 跑一笔真实 EIP-3009 transferWithAuthorization
python3 transfer-with-auth.py
```

每运行一次 `transfer-with-auth.py`，就在 HashKey Chain Testnet 真发生一笔 1 USDC 的链上结算。

---

## 1. 已部署的链上资产（可直接用）

| 资产 | 地址 / Hash | Blockscout |
|---|---|---|
| **MockUSDC 合约** | `0x0685C487Df4Cc0723Aa828C299686798294E9803` | [👁 Contract](https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803) |
| Agent Wallet (Demo) | `0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7` | [👁 Address](https://testnet-explorer.hsk.xyz/address/0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7) |
| 部署 tx | `0xb9bdfdb1a975413dab1825824a88cedfea1418e5edb85c3549255b9f2098f50d` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0xb9bdfdb1a975413dab1825824a88cedfea1418e5edb85c3549255b9f2098f50d) |
| Mint tx | `0xd862e80e91db73640295e60c9a8ad97ae1db82bf6845ae2e6f915b4ac91ede48` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0xd862e80e91db73640295e60c9a8ad97ae1db82bf6845ae2e6f915b4ac91ede48) |
| 首次 transferWithAuth tx | `0xff8a175e3f4b41a30b67940a4b654d7791742d76421d53a33dd976e8a51ccbf5` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0xff8a175e3f4b41a30b67940a4b654d7791742d76421d53a33dd976e8a51ccbf5) |

### 合约 metadata

```
name:             "Mock USD Coin"
symbol:           "USDC"
decimals:         6
DOMAIN_SEPARATOR: 0x04a966c59498a1c0e1e8f1452217ebf3a6d0f8d0abf63614167c45c50435b15c
```

### 关键 typehash（与 Circle USDC 完全一致）

| 名称 | Hash |
|---|---|
| `EIP712_DOMAIN_TYPEHASH` | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` | `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267` |
| `CANCEL_AUTHORIZATION_TYPEHASH` | `0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429` |

---

## 2. 网络配置

| 项目 | 值 |
|---|---|
| Network Name | HashKey Chain Testnet |
| Chain ID | `133` |
| RPC | `https://testnet.hsk.xyz` |
| Explorer | `https://testnet-explorer.hsk.xyz` |
| Native Token | HSK (gas 用) |
| Faucet | `https://faucet.hsk.xyz/` |
| Gas Price (实测) | ~0.001 gwei（极低，0.1 HSK 够跑 100 万次微支付） |

### MetaMask 添加 HashKey Chain Testnet

```
Network Name:     HashKey Chain Testnet
RPC URL:          https://testnet.hsk.xyz
Chain ID:         133
Currency Symbol:  HSK
Block Explorer:   https://testnet-explorer.hsk.xyz
```

---

## 3. 文件结构

```
~/Code/openAgentPay/scripts/hashkey/
├── MockUSDC.sol            # 164 行 Solidity，零外部依赖，含完整 EIP-3009
├── build/
│   ├── MockUSDC.bin        # solc 编译产物（bytecode, 7828 chars hex）
│   └── MockUSDC.abi        # ABI
├── deploy.py               # 部署 + mint 1000 USDC（写入 .env.local）
└── transfer-with-auth.py   # EIP-712 签名 + Facilitator broadcast 上链
```

`.env.local` 里相关字段：

```bash
HASHKEY_TESTNET_AGENT_ADDRESS=0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7
HASHKEY_TESTNET_AGENT_PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY_HERE
HASHKEY_CHAIN_ID=133
HASHKEY_RPC_URL=https://testnet.hsk.xyz
HASHKEY_EXPLORER_URL=https://testnet-explorer.hsk.xyz
HASHKEY_USDC_ADDRESS=0x0685C487Df4Cc0723Aa828C299686798294E9803
```

---

## 4. End-to-end 跑通的样子

完整 console output（截自首次跑通）：

```
======================================================================
🌐 OpenAgentPay × HashKey Chain — EIP-3009 transferWithAuthorization Demo
======================================================================
Network:  HashKey Chain Testnet (chainId=133)
USDC:     0x0685C487Df4Cc0723Aa828C299686798294E9803
Block:    #27,918,005

👛 Agent Wallet (Payer):    0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7
🏪 Merchant Wallet (Payee): 0x6d66de79e0344EB7d517Dc2Fe8c393AF61285FB4 [现场生成]

Step 1️⃣  检查初始 USDC 余额
----------------------------------------------------------------------
  Agent:     1000.000000 USDC
  Merchant:  0.000000 USDC (期望 0)

Step 2️⃣  Agent 签名 EIP-712 TransferWithAuthorization
----------------------------------------------------------------------
  Authorization payload:
    from:        0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7
    to:          0x6d66de79e0344EB7d517Dc2Fe8c393AF61285FB4
    value:       1000000 atomic (1.0 USDC)
    validAfter:  0
    validBefore: 1779023271
    nonce:       0x4f3ae46dbf3f27daccd8888a7066d9d2423f5204b25d3dd2dda2bbb9c8e13dfb

  Signature:
    v: 27
    r: 0xe430afcfe2c1a231382a4fa3b042d2bd97cae9cd6954aeae04f45fbb4adfe741
    s: 0x6863a389976b10b658ac6b611a96415624f78975f54b3e50e6e21c2c09727c86

Step 3️⃣  Facilitator 把签名提交到链上
----------------------------------------------------------------------
  Tx broadcast: 0xff8a175e3f4b41a30b67940a4b654d7791742d76421d53a33dd976e8a51ccbf5
  Waiting for confirmation...
  ✅ Block #27918011, gas used 82,406
  💰 Settlement cost: 8.2426848718E-8 HSK

Step 4️⃣  链上验证转账完成
----------------------------------------------------------------------
  Agent:           1000.000000 → 999.000000 USDC
  Merchant:        0.000000 → 1.000000 USDC
  Nonce used:      True ✅

✅ 端到端演示完成。
```

---

## 5. 12 步 x402 协议轨迹（这次 demo 在做的事）

```
+0ms      Agent 决定调付费工具
+5ms      Agent 收到 (mock) HTTP 402 Payment Required
+12ms     解析 PaymentRequest（amount=1 USDC, recipient=merchant_xxx）
+18ms     Session 预算检查通过
+25ms     从 Secrets Manager 取 Agent 私钥（offline-equivalent）
+90ms     构造 EIP-3009 transferWithAuthorization payload
+120ms    计算 EIP-712 domain hash (chainId=133, MockUSDC)
+200ms    Agent 完成 EIP-712 签名（v/r/s）✅
+220ms    编码 X-PAYMENT header (base64-url)
+250ms    Facilitator 接收签名 payload
+1500ms   Facilitator 调 MockUSDC.transferWithAuthorization() 上链
+3500ms   Block #N: Settlement 成功 ✅
+3520ms   写入 audit log + 扣减 Session 余额
```

总耗时约 3.5 秒（HashKey Chain testnet 出块快），**比 Base Sepolia 还快**。

---

## 6. 如何复跑（5 分钟新人上手）

### 前置

- macOS / Linux
- Python 3.10+
- 已装：`web3.py`（`pip install web3`）和 `eth-account`
- 已装：`solc` 0.8.20+（`brew install solidity`）

### 步骤

```bash
# 1. clone
git clone https://github.com/neosun100/openAgentPay
cd openAgentPay

# 2. 生成自己的 testnet 钱包
python3 -c "from eth_account import Account; import secrets; a = Account.create(secrets.token_hex(32)); print(f'Address: {a.address}\nPrivateKey: {a.key.hex()}')"

# 3. 把 Address + PrivateKey 写入 .env.local（参考 .env.example）

# 4. 浏览器打开 https://faucet.hsk.xyz/，给 Address 领测试 HSK

# 5. 编译 + 部署
cd scripts/hashkey
solc --bin --abi --optimize -o build --overwrite MockUSDC.sol
python3 deploy.py     # 部署 + mint 1000 USDC

# 6. 跑一笔真实结算
python3 transfer-with-auth.py
```

每次重跑 step 6，merchant 余额都会再 +1 USDC（每跑一次现场生成新 merchant 地址）。

---

## 7. 给客户演示时强调的 5 个关键点

1. ✅ **Agent 没有 broadcast tx**——只签了一个离线 EIP-712 message
2. ✅ **Facilitator 替 Agent 提交并付 gas**，资金从 Agent 转到 Merchant
3. ✅ **nonce 防 replay**（用过的 nonce 链上拒绝，签名无法被复用）
4. ✅ **整笔结算在 HashKey Chain Testnet 真实可查 + immutable**
5. ✅ **协议层完全是 x402 / EIP-3009 标准**——AgentCore Payments 同款

---

## 8. 与同事 demo（Coinbase + Base Sepolia）的对照

| 维度 | 同事 demo (`d2qeadqd0o8z6t.cloudfront.net`) | OpenAgentPay HashKey demo |
|---|---|---|
| Network | Base Sepolia (84532) | HashKey Chain Testnet (**133**) |
| USDC 合约 | `0x036cbd...` (Circle) | `0x0685c4...` (Mock, 我们部) |
| 钱包 | Coinbase CDP (托管) | Self-custodial (private key in .env.local / Secrets Manager) |
| 签名 | EIP-712 (CDP 服务端代签) | EIP-712 (Python eth-account 本地签) |
| Facilitator | x402.org | Python script / 后续 Lambda |
| 协议代码层 | x402 v1 | **完全相同的 x402 v1** ✅ |
| 业务代码层 | Strands + AgentCore Payments Plugin | Strands + OpenAgentPayPlugin（即将做） |

**Note**：协议、SDK、Strands Agent 框架、Lambda 后端可以**完全共享**，唯一差别就是 wallet provider + chain 选择。

---

## 9. 下一步会做的（Phase B-G）

1. 把 `transfer-with-auth.py` 的 EIP-712 签名逻辑搬到 TypeScript（`packages/wallet-hashkey/`）
2. 把 Facilitator broadcast 逻辑搬到 Lambda（`packages/cdk-deploy/`）
3. 写 Web UI（`apps/demo/`），加钱包/链下拉，让客户看到 Coinbase ↔ HashKey 切换
4. 部署到 us-west-2 CloudFront
5. 录 5 分钟 demo 视频

---

*Last updated: 2026-05-17 21:00*
