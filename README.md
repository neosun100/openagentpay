# OpenAgentPay

> 🌐 **Open, pluggable Agent Payments platform** for AWS Bedrock AgentCore — any wallet, any protocol, any governance.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-MVP-orange)](#roadmap)
[![Made for](https://img.shields.io/badge/Made_for-AWS_Bedrock_AgentCore-FF9900)](https://aws.amazon.com/bedrock/agentcore/)

---

## ✨ What is OpenAgentPay?

OpenAgentPay 是面向 AI Agent 经济的**开放式支付协议平台**。它在 AWS Bedrock AgentCore Payments (Preview) 之上，提供一套可插拔的 Wallet / Protocol / Governance 三层抽象，让任何钱包、任何协议、任何企业治理逻辑都能即插即用接入。

**类比**：Kubernetes 之于容器编排（CRI/CSI/CNI 标准化），OpenAgentPay 想做 Agent Payments 的 **CRI 时刻**。

### 解决什么问题？

AWS AgentCore Payments 当前 Preview 只支持 **Coinbase CDP** 和 **Stripe Privy** 两个钱包 + **x402** 协议。这对：

- 🇨🇳 中国 / 🇸🇬 新加坡 / 🇭🇰 香港 等亚洲 FSI 客户（用 Binance / OKX / Bitget / Bybit / HashKey 钱包） 
- 🌐 Web3-native 客户（用 MetaMask / WalletConnect）
- 💳 传统支付场景（支付宝 / 微信 / Stripe 信用卡）
- 🔐 自主企业合规要求

—— **完全无法覆盖**。

OpenAgentPay 让你**保留 AgentCore 的 Runtime / Identity / Gateway / Observability**，仅替换 Payments 模块的 **Wallet Connector** + **Protocol Adapter** 两层 → 适配上述所有场景。

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenAgentPay Platform                        │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Strands Plugin (drop-in compatible with AgentCore)    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Payment Orchestrator                                   │
│   SessionManager · SpendGovernor · ProtocolRouter · Telemetry  │
├──────────────────────────┬──────────────────────────────────────┤
│ Layer 3: Protocols       │ Layer 4: Wallet Connectors           │
│   x402 v1/v2             │   Coinbase CDP · Stripe Privy        │
│   MPP (IETF Draft)       │   Binance Pay · OKX · Bitget · Bybit │
│   AP2 (FIDO)             │   HashKey · MetaMask · WalletConnect │
│   Custom CEX Pay (OAP)   │   Alipay · WeChat Pay · Custom       │
├──────────────────────────┴──────────────────────────────────────┤
│ Layer 5: Self-Hosted Facilitator (optional)                     │
├─────────────────────────────────────────────────────────────────┤
│ Layer 6: Plugin Registry (community ecosystem)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start (MVP · Binance Pay)

```python
from strands import Agent
from strands_tools import http_request
from openagentpay import OpenAgentPayPlugin, OpenAgentPayConfig, PaymentManager

# 1. 创建 Payment Manager（Lambda 后端）
manager = PaymentManager(arn="arn:aws:lambda:us-west-2:...")

# 2. 创建限额会话
session = manager.create_session(user_id="alice", budget_usd=1.00, expires_minutes=60)

# 3. 配置插件 — 关键差异：wallet_provider = "binance"
cfg = OpenAgentPayConfig(
    payment_manager_arn=manager.arn,
    payment_instrument_id="payment-instrument-...",
    payment_session_id=session.id,
    user_id="alice",
    wallet_provider="binance",      # ← Binance Pay (or "coinbase", "okx", "metamask"...)
    protocol="cex-pay",             # ← Custom CEX Pay (or "x402-v1", "x402-v2", "mpp"...)
)

# 4. 挂到 Agent — 业务代码与 AgentCore Payments 完全一致
agent = Agent(
    model_id="global.anthropic.claude-sonnet-4-6-v1:0",
    tools=[http_request],
    plugins=[OpenAgentPayPlugin(config=cfg)],
)

# 5. 调用 — 402 / 签名 / 结算 / 审计 全自动
result = agent("Fetch the premium analytics report")
print(manager.get_session(session.id).total_spent_usd)
```

**业务代码与 AgentCore Payments 100% 兼容** —— 只换 `wallet_provider` 和 `protocol` 两个字段。

---

## 📦 项目结构

```
openagentpay/
├── packages/
│   ├── core/              # 核心 Orchestrator + 接口定义（TS）
│   ├── wallet-binance/    # Binance Pay Connector
│   ├── protocol-cex-pay/  # Custom CEX Pay Protocol Adapter
│   ├── strands-plugin/    # Strands Plugin (Python wrapper)
│   ├── cdk-deploy/        # AWS CDK Infrastructure
│   └── python-sdk/        # Python SDK（同形态接口）
├── apps/
│   └── demo/              # Live Demo Web UI
└── docs/                  # 架构 / 贡献 / How to add wallet
```

---

## 🗺️ Roadmap

### 🚀 阶段 1 · MVP（第 1-4 周）— 当前阶段
- [x] 项目脚手架 + Apache 2.0
- [ ] Wallet Connector 接口定义
- [ ] **Binance Pay Connector**（首个非 Coinbase 钱包）
- [ ] Custom CEX Pay v0.1 协议
- [ ] Session Manager (DynamoDB)
- [ ] Strands Plugin
- [ ] Lambda 部署 + Demo Web UI
- [ ] 5 分钟 demo 视频 + 中英博客

### 🌱 阶段 2 · 多钱包扩展（第 2-3 月）
- OKX Pay · Bitget Wallet · Bybit Pay · HashKey Pro
- MetaMask Snap · WalletConnect v2
- 兼容性 Connector：Coinbase CDP · Stripe Privy

### 🌳 阶段 3 · 多协议扩展（第 4-6 月）
- x402 v1 / v2 · MPP (IETF Draft) · AP2 (FIDO) · ACP (OpenAI)

### 🌍 阶段 4 · 生态启动（第 7-9 月）
- `openagentpay.io` Registry · CLI · Playground

### 🏆 阶段 5 · 标准化（第 10-12 月）
- IETF/W3C 提案 · re:Invent 2026 演讲 · 商业版 SaaS

---

## 🤝 How to Add Your Own Wallet

1. Fork `packages/wallet-binance` as template
2. Implement `WalletConnector` interface (5 methods)
3. Add conformance tests (5 standard tests, all must pass)
4. Submit PR
5. Auto-published to npm/pypi after merge

详见 [docs/HOW_TO_ADD_WALLET.md](./docs/HOW_TO_ADD_WALLET.md) (TBD)

---

## 📚 Related

- [AWS Bedrock AgentCore Payments (Preview)](https://aws.amazon.com/bedrock/agentcore/) — 我们扩展的对象
- [x402 Protocol](https://www.x402.org/) — 主流协议之一，我们的 Protocol Adapter 之一
- [研究报告](https://github.com/neosun100/fsidnb-agentcore-payment) — AgentCore Payments 完整深度分析（前期研究）

---

## 📝 License

[Apache License 2.0](LICENSE) © 2026 Neo Sun and OpenAgentPay Contributors

> 本项目**不代表 AWS / Coinbase / Stripe / Binance 任何官方立场**，是独立开源生态项目。

---

*Status: MVP under active development · Last updated 2026-05-16*
