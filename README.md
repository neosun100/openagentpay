# OpenAgentPay

> 🌐 **Open, pluggable Agent Payments platform** for AWS Bedrock AgentCore — any wallet, any protocol, any governance.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-Live_on_AWS-brightgreen)](https://d1p7yxa99nxaye.cloudfront.net)
[![Made for](https://img.shields.io/badge/Made_for-AWS_Bedrock_AgentCore-FF9900)](https://aws.amazon.com/bedrock/agentcore/)
[![HashKey Chain](https://img.shields.io/badge/Live_on-HashKey_Chain_Testnet-purple)](https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803)
[![Tests](https://img.shields.io/badge/tests-82_passing-brightgreen)](#)

> **🌐 Live demo**: https://d1p7yxa99nxaye.cloudfront.net （已部署到 AWS us-east-1，CloudFront + Lambda + Secrets Manager）
>
> **🚀 Live update (2026-05-17)**: OpenAgentPay 端到端 demo 已经在 **HashKey Chain Testnet** 上跑通：
> 浏览器 → CloudFront → AWS Lambda (us-east-1) → Secrets Manager 取私钥 → EIP-712 签名 →
> HashKey Chain Testnet 上链 → 在 Blockscout immutable 可查。
>
> **协议层与 AWS AgentCore Payments / Coinbase CDP / Base Sepolia 路径完全对等**
> ——业务代码层面只换一行 `walletProvider`。
>
> 详见 [📋 战略文档](./docs/STRATEGY.md) ·
> [⚡ Quickstart](./docs/QUICKSTART.md) ·
> [🔬 HashKey 链上 demo 复现指南](./docs/HASHKEY_DEMO.md) ·
> [🎤 演讲材料](./docs/PRESENTATION.md) ·
> [📚 参考代码 vendor 计划](./docs/REFERENCES.md)。

---

## 🚀 What you'll see in 5 minutes

```bash
git clone https://github.com/neosun100/openAgentPay && cd openAgentPay
pnpm install
# (configure .env.local — see docs/QUICKSTART.md)
pnpm demo
# → open http://localhost:5173
```

![Run Demo Tab](docs/screenshots/04-run-demo-after-pay.png)

> **Live update (2026-05-17)**: OpenAgentPay 的端到端 demo 已经在
> **HashKey Chain Testnet** 上跑通：从 Vite + React 三 Tab UI →
> Express API → `PaymentManager` → `HashKeyChainConnector` →
> EIP-3009 `transferWithAuthorization` → 链上 settlement 真实可查。
>
> **协议层与 AWS AgentCore Payments / Coinbase CDP / Base Sepolia 路径完全对等**
> ——业务代码层面只换一行 `walletProvider`。详见
> [📋 战略文档](./docs/STRATEGY.md) ·
> [⚡ Quickstart](./docs/QUICKSTART.md) ·
> [🔬 HashKey 链上 demo 复现指南](./docs/HASHKEY_DEMO.md)。

---

## ✨ What is OpenAgentPay?

OpenAgentPay 是面向 AI Agent 经济的**开放式支付协议平台**。它在 AWS Bedrock AgentCore Payments (Preview) 之上，提供一套可插拔的 Wallet / Protocol / Governance 三层抽象，让任何钱包、任何协议、任何企业治理逻辑都能即插即用接入。

**类比**：Kubernetes 之于容器编排（CRI/CSI/CNI 标准化），OpenAgentPay 想做 Agent Payments 的 **CRI 时刻**。

### 解决什么问题？

AWS AgentCore Payments 当前 Preview 只支持 **Coinbase CDP** 和 **Stripe Privy** 两个钱包 + **x402** 协议。这对：

- 🇭🇰 **HashKey** 等亚洲合规交易所客户（持牌、做 RWA、做 HKD 稳定币 HKDR）
- 🇨🇳 **Binance Pay / OKX / Bitget** 等亚洲 CEX
- 🌐 **Web3-native** 客户（MetaMask / WalletConnect）
- 💳 **传统支付场景**（支付宝 / 微信 / Stripe 信用卡）

—— 全部不可用。

OpenAgentPay 让你**保留 AgentCore 的 Runtime / Identity / Gateway / Observability**，仅替换 Payments 模块的 **Wallet Connector** + **Protocol Adapter** 两层 → 适配上述所有场景。

详细战略 + 路径选择 + 资产分级 → 见 [📋 docs/STRATEGY.md](./docs/STRATEGY.md)。

---

## 🎬 Live Demo

### Tab 1: Run Demo · 4 步手动跑链上结算

![Run Demo](docs/screenshots/01-run-demo.png)

四步流程：
1. **GET /api/wallet** → live 链上 USDC 余额
2. **POST /api/session** → 创建 Payment Session（预算 + TTL）
3. **POST /api/pay** → EIP-712 签名 + Facilitator 上链结算（**~5 秒**）
4. **GET /api/session/:id** → Session 累计花费

### Tab 2: How It Works · 8 步全链路图

![How It Works](docs/screenshots/02-how-it-works.png)

每一步配 OpenAgentPay 实现细节。Step 6 显示 EIP-712 typed data 完整结构，Step 7 显示 ecrecover 合约逻辑。

### Tab 3: AI Agent · 真 Strands 风格

![AI Agent](docs/screenshots/03-ai-agent.png)

3 个工具（free + 2 paid）+ 3 个预设 prompt。付费按钮触发**真实链上结算**，免费按钮纯 mock。

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenAgentPay Platform                        │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Strands Plugin (drop-in compatible with AgentCore)    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Payment Orchestrator                                   │
│   PaymentManager · SessionManager · ConnectorRegistry          │
├──────────────────────────┬──────────────────────────────────────┤
│ Layer 3: Protocols       │ Layer 4: Wallet Connectors           │
│   x402 v1/v2 ✅           │   Coinbase CDP · Stripe Privy        │
│   OAP-CEX v0.1 ✅         │   HashKey Chain ✅ (live)            │
│   MPP / AP2 / ACP        │   Binance Pay ✅ (OAP-CEX)           │
│                          │   OKX · Bitget · MetaMask · …        │
├──────────────────────────┴──────────────────────────────────────┤
│ Layer 5: Self-Hosted Facilitator (Express API → Lambda later)   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 项目结构

```
openagentpay/
├── packages/
│   ├── core/                  # PaymentManager + types + SessionManager
│   ├── wallet-binance/        # Binance Pay Connector (OAP-CEX)
│   ├── wallet-hashkey/        # HashKey Chain Connector (x402, EVM) ⭐
│   ├── protocol-cex-pay/      # Custom CEX Pay Protocol Adapter
│   ├── strands-plugin/        # Strands Plugin (Python)
│   ├── cdk-deploy/            # AWS CDK Infrastructure
│   └── python-sdk/            # Python SDK
├── apps/
│   ├── demo-api/              # Express server (→ Lambda Function URL)
│   └── demo-web/              # Vite + React three-tab UI
├── scripts/
│   ├── binance-smoke.ts       # Binance Pay sandbox e2e
│   ├── hashkey-smoke.ts       # HashKey Chain Testnet e2e (TS)
│   └── hashkey/               # MockUSDC + Python e2e ref impl
└── docs/
    ├── STRATEGY.md            # 项目北极星文档
    ├── HASHKEY_DEMO.md        # HashKey Chain demo 复现指南
    └── QUICKSTART.md          # 5 分钟跑通 demo
```

---

## 🌐 链上事实（已验证）

OpenAgentPay 不是想法，是已经在 HashKey Chain Testnet 上跑通的事实：

| 资源 | Address / Hash | 链接 |
|---|---|---|
| **MockUSDC 合约** | `0x0685C487Df4Cc0723Aa828C299686798294E9803` | [👁 Contract](https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803) |
| 部署 tx | `0xb9bdfdb1...` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0xb9bdfdb1a975413dab1825824a88cedfea1418e5edb85c3549255b9f2098f50d) |
| Python e2e tx | `0xff8a175e...` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0xff8a175e3f4b41a30b67940a4b654d7791742d76421d53a33dd976e8a51ccbf5) |
| TypeScript e2e tx | `0x5c10e2ae...` | [📜 Tx](https://testnet-explorer.hsk.xyz/tx/0x5c10e2ae5a152169c5870ce440f7ee2c5bbd26410690d8424af79d547df5f098) |

**两个完全独立的实现（Python + TypeScript）产生完全相同的链上效果**——证明协议层抽象正确。

---

## 🚀 Quick Start

详细 5 分钟指南：[docs/QUICKSTART.md](./docs/QUICKSTART.md)

```bash
git clone https://github.com/neosun100/openAgentPay
cd openAgentPay
pnpm install
# 配置 .env.local（见 QUICKSTART）
pnpm demo
# → http://localhost:5173
```

也能跑命令行 smoke test：

```bash
pnpm smoke:hashkey   # TypeScript 端到端 → 真上链
# 或
python3 scripts/hashkey/transfer-with-auth.py   # Python ref impl
```

---

## 🗺️ Roadmap

> 这个 roadmap **不写时间**——OpenAgentPay 的核心抽象（`WalletConnector` + `ProtocolAdapter`）已经验证正确，剩下的扩展全是按通用接口的机械工作，**接入一个新钱包通常只需要 1-2 天**。具体节奏跟随生态进展和合作伙伴需求。

### ✅ Phase 1 · MVP demo（已完成 2026-05-17）
- [x] 项目脚手架 + Apache 2.0
- [x] WalletConnector + ProtocolAdapter 接口定义
- [x] **Binance Pay Connector**（OAP-CEX 协议路径）
- [x] **OAP-CEX v0.1 协议**规范 + adapter
- [x] **PaymentManager** 顶层抽象（对齐 AgentCore Payments）
- [x] **MockUSDC + EIP-3009** 部署到 HashKey Chain Testnet
- [x] **HashKey Chain Connector**（x402 路径，TypeScript）
- [x] Python 参考实现 + TypeScript 实现——**两份独立代码产生相同链上效果**
- [x] Express API server + Vite React 三 Tab UI
- [x] 端到端 demo 跑通（local + AWS 生产）

### ✅ Phase 2 · AWS 生产部署（已完成 2026-05-17）
- [x] CDK Stack：Lambda Function URL + CloudFront + S3 + Secrets Manager (KMS)
- [x] 浏览器 → CloudFront → Lambda → Secrets Manager → HashKey Chain 全链路真实运行
- [x] **Live URL**: https://d1p7yxa99nxaye.cloudfront.net
- [x] AWS Lambda 上链 verified ([tx 0xd18cb0f1...](https://testnet-explorer.hsk.xyz/tx/0xd18cb0f19359bdaae17aa89a0e14c47ccb7793579b9a09ac0423eefb1390a06a))

### 🌱 Phase 3 · 通用钱包接入（持续演进）

**核心理念**：任何钱包，只要满足 `WalletConnector` 接口的 5 个方法，都能即插即用接入。我们提供：
- 📐 **接入指南** + 模板 fork（参考 `packages/wallet-hashkey/`）
- ✅ **5 个 conformance test**（全过即合规）
- 📦 **自动发布到 npm**（merge 即 publish）

**正在/即将接入的钱包**（顺序按 demand 触发，非时间排序）：

| 类别 | 钱包 | 协议路径 | 状态 |
|---|---|---|---|
| **EVM 自托管（x402 路径）** | HashKey Chain · MetaMask Snap · WalletConnect v2 · Rainbow · Phantom (EVM) | x402 v1 | HashKey ✅ done · 其余正在接 |
| **AWS 原版兼容** | Coinbase CDP · Stripe Privy | x402 v1 | 路径 D 另一半，可即插即用 |
| **CEX-API（OAP-CEX 路径）** | Binance Pay ✅ · OKX Pay · Bitget Wallet · Bybit Pay · HashKey Pro Sandbox | OAP-CEX v0.1 | Binance done · 其余按需触发 |
| **传统支付** | Stripe（信用卡）· 支付宝 · 微信支付 | 待定 protocol | 看市场需求 |

**目标**：覆盖全部主流钱包/支付方式。**只要客户提需求 + 钱包方有 API，1-2 天内就能 ship 一个新 connector**。

### 🌳 Phase 4 · 标准化与生态（持续推进）

- **协议提案**：把 OAP-CEX v0.1 推进 IETF/W3C
- **AgentCore 原生集成**：与 AWS Bedrock AgentCore Payments 团队对接，让 OpenAgentPay 成为官方扩展层
- **稳定币原生支持**：USDC ✅ · HKDR（HashKey 港币）· FDUSD · USDT · WHSK · 任何 EIP-3009 兼容 ERC-20 都自动支持
- **商业版 SaaS**：Self-hosted facilitator 之上的托管运营

**节奏**：跟随生态成熟度——上述大多数项目都不需要"几个月"，而是"看到信号就行动"。OpenAgentPay 的协议层已经为这些场景留好了 plug-in 点。

---

## 🤝 How to Add Your Own Wallet

1. Fork `packages/wallet-hashkey/` 作为模板
2. 实现 `WalletConnector` 接口（5 方法）
3. 加 conformance tests（5 个标准测试，全过即通过）
4. 提 PR
5. 合并后自动发布到 npm

---

## 📚 Related

- [AWS Bedrock AgentCore Payments (Preview)](https://aws.amazon.com/bedrock/agentcore/) — 我们扩展的对象
- [x402 Protocol](https://www.x402.org/) — 主流协议之一
- [HashKey Chain Docs](https://docs.hsk.xyz/) — 我们 demo 跑的链
- [研究报告](https://github.com/neosun100/fsidnb-agentcore-payment) — AgentCore Payments 完整深度分析

---

## 📝 License

[Apache License 2.0](LICENSE) © 2026 Neo Sun and OpenAgentPay Contributors

> 本项目**不代表 AWS / Coinbase / Stripe / Binance / HashKey 任何官方立场**，是独立开源生态项目。

---

*Status: MVP demo live · Last updated 2026-05-17*
