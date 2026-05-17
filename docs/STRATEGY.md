# OpenAgentPay · Strategy & Architecture

> **作者**：Neo Sun (`@neosun100`) + Kiro AI assistant
> **状态**：Active · 持续更新
> **创建**：2026-05-17（HashKey Chain Testnet e2e 跑通日）
> **License**：Apache-2.0

---

## 一、本质：Agent Payments 的 CRI 时刻

OpenAgentPay **不是一个钱包产品**，**也不是 AgentCore Payments 的"开源平替"**。它是 **AI Agent 支付协议的开放标准 + 参考实现 + 一致性测试套件**——类比 Kubernetes CRI/CSI/CNI，让任何钱包、任何协议、任何治理逻辑都能**即插即用**接入 AI Agent。

### 项目定位

```
                    ┌──────────────────────────────────────┐
                    │         AI Agent Payments           │
                    │            生态全景                   │
                    └──────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Layer 1        │     │  Layer 2            │     │  Layer 3        │
│  Protocol       │     │  Internal Governance│     │  Settlement     │
│  (x402/MPP/AP2) │     │  (OpenAgentPay      │     │  (USDC, FDUSD,  │
│                 │     │   ⭐ 我们在这里 ⭐)  │     │   HKDR, USDT…)  │
└─────────────────┘     └─────────────────────┘     └─────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │  Layer 4               │
                        │  Wallet Network        │
                        │  (Coinbase CDP, Privy, │
                        │   HashKey Chain,       │
                        │   Binance Pay, …)      │
                        └────────────────────────┘
```

OpenAgentPay 主要工作在 **Layer 2（治理 + 编排）**，向上对齐 Layer 1 协议（x402 / OAP-CEX），向下支持 Layer 4 多种钱包/链。

---

## 二、与 AWS AgentCore Payments 的关系：路径 D 混合方案

AWS Bedrock AgentCore Payments (Preview, 2026-05-07 发布) 的当前限制：

| 限制项 | 现状 | 影响 |
|---|---|---|
| 钱包枚举 | 只支持 `CoinbaseCDP` / `StripePrivy` | 亚洲 FSI（HashKey/Binance/OKX/Bitget）完全不可用 |
| 协议枚举 | 只支持 `x402` | 不支持 OAP-CEX / MPP / AP2 |
| Region | 4 个（美东、美西、法兰克福、悉尼）| 香港、新加坡、东京、印度都没覆盖 |
| 资产 | 主要是 USDC | HKDR、FDUSD、HSK 等亚洲稳定币缺位 |
| BYO Wallet | 不开放 | `type` 字段在服务端枚举校验 |

### 我们采取「路径 D 混合方案」

> **客户在前端下拉选钱包：**
> - 选 **Coinbase CDP / Stripe Privy** → 走原版 AgentCore Payments（不动）
> - 选 **HashKey / Binance / OKX / Mock** → 走 OpenAgentPay 扩展层
>
> **业务代码完全不变。**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Strands Agent (业务代码)                          │
│                                                                          │
│              plugins=[ OpenAgentPayPlugin(config=cfg) ]                  │
│                                  │                                       │
└──────────────────────────────────┼───────────────────────────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
       wallet=coinbase_cdp  wallet=hashkey      wallet=binance_pay
                │                  │                  │
                ▼                  ▼                  ▼
       ╔══════════════╗   ╔═══════════════╗   ╔═══════════════╗
       ║ AgentCore    ║   ║ OpenAgentPay  ║   ║ OpenAgentPay  ║
       ║ Payments     ║   ║ HashKey       ║   ║ Binance Pay   ║
       ║ (AWS 原版)    ║   ║ Connector     ║   ║ Connector     ║
       ╚══════════════╝   ╚═══════════════╝   ╚═══════════════╝
                │                  │                  │
                ▼                  ▼                  ▼
       Coinbase CDP        HashKey Chain         Binance Pay
       Base Sepolia        Testnet (133)         Sandbox API
       USDC                MockUSDC              USDT/USDC
       (x402)              (x402, ✅ 已跑通)      (OAP-CEX v0.1)
```

### 这个方案的好处

1. **客户体验等同**——下拉切换，业务代码 1 行不改
2. **AWS 路径不动**——避免与 AgentCore Payments 团队竞争或冲突
3. **扩展层独立**——我们的 Lambda 出问题不影响 AWS 路径
4. **未来无缝合并**——AWS 开放 BYO 时，我们的 connector 直接 register 进 `CreatePaymentConnector` 的 enum

---

## 三、资产策略：稳定币优先 + 三档分级

> 详见对话记录 2026-05-17 关于"币安没有稳定币"的讨论

### Tier 1: 主推稳定币（链上 + CEX 都支持）

| 稳定币 | 发行方 | 链 / CEX 支持 | OpenAgentPay 支持时间表 |
|---|---|---|---|
| **USDC** | Circle | Base / Ethereum / HashKey Chain (mainnet) / Solana | v0.1 ✅（mock USDC 已部署） |
| **USDT** | Tether | 几乎所有 EVM 链 + Binance Pay + HashKey Pro | v0.2 |
| **FDUSD** | First Digital (HK) | BSC / Ethereum + Binance | v0.2 |
| **HKDR** | RD InnoTech (与 HashKey 合作) | 即将上 Ethereum | v0.3，**HashKey 客户最关心** ⭐ |

### Tier 2: Wrapped 原生 token（demo 演示用，非主推）

| Token | Wrapped 形态 | 用途 |
|---|---|---|
| HSK | WHSK (`0xB210D2120d57b758EE163cFfb43e73728c471Cf1`) | HashKey 客户附加演示 |
| BNB | WBNB | Binance 客户附加演示 |
| ETH | WETH | 通用兜底 |

⚠️ 价格波动让微支付不稳定，仅适合大额一次性。

### Tier 3: CEX-internal（走 OAP-CEX 协议，不上链）

| Provider | 资产 | 协议 |
|---|---|---|
| Binance Pay | USDT / USDC / BNB | OAP-CEX v0.1 + HMAC-SHA512 |
| HashKey Pro Sandbox | USDT / USDC / HSK / BTC / ETH | OAP-CEX v0.1 + HMAC-SHA256 |
| OKX Pay (v0.2) | USDT / USDC / OKB | OAP-CEX |
| Alipay/微信 (v0.3) | RMB | OAP-CEX 扩展 |

---

## 四、协议层：x402 + OAP-CEX 双轨

> **核心 architectural insight**：x402 协议的"形状"（402 challenge → sign → retry）是好的，但"加密层 + 结算层"应该**可插拔**。一个协议无法同时服务链上钱包和 CEX 钱包——它们的世界观根本不一样。

**为什么 Binance 不用 x402？** 因为 x402 在链下世界根本不成立：

| x402 要求 | Binance 现实 | 后果 |
|---|---|---|
| EIP-712 typed data 签名 + secp256k1 ECDSA | Binance API 用 HMAC-SHA512 签名 | 签名格式不对应 |
| EIP-3009 ERC-20 合约调用 | Binance 后端是中心化数据库，不部 ERC-20 | 没有合约可调 |
| 公链 settlement | CEX 内部账本记账 | 上链反而更慢 + 更贵 |
| `0x...` 以太坊地址作为 recipient | Binance 用内部 merchant ID | 地址类型不对应 |

**强行套 x402 = 让中心化数据库假装成 ERC-20 合约**，既笨拙又违背 CEX 的低成本优势。

**OpenAgentPay 的解法**：保留 x402 的协议形状，但把签名层 + 结算层抽象出来：
- **x402** = 协议形状 + EIP-712 签名层（HashKey Chain / Coinbase / MetaMask 用）
- **OAP-CEX** = 同样协议形状 + HMAC 签名层（Binance Pay / OKX / HashKey Pro 用）

两者共享 `ProtocolAdapter` 接口；`PaymentManager` 通过 `ProtocolRouter` 自动按 402-response signature 派发。**业务代码层面只换一行 `walletProvider`**。

| 维度 | x402 (链上) | OAP-CEX (CEX 内部) |
|---|---|---|
| 资产 | EIP-3009 兼容 ERC20 | CEX 支持的任意币种 |
| 链 | 任意 EVM | 不上链（CEX 内部账） |
| 签名 | EIP-712 | HMAC-SHA512/256 |
| 协议来源 | Coinbase 开源 | OpenAgentPay 自研 v0.1 |
| Facilitator | x402.org / 我们自托管 | 由钱包商自己 settle |
| 适用场景 | 公开微支付，any-merchant | KYC 合规，高额 B2B |

**OpenAgentPay 的差异化**：**两条协议都支持**，前端钱包下拉时同时切换协议。

---

## 五、HashKey Chain 路径：已验证 ✅

### 链上事实（2026-05-17）

| 资产 | 地址 / Tx |
|---|---|
| MockUSDC 合约 | `0x0685C487Df4Cc0723Aa828C299686798294E9803` |
| Agent Wallet | `0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7` |
| 部署 tx | `0xb9bdfdb1...2098f50d` (block #27,917,983) |
| Mint tx | `0xd862e80e...ac91ede48` |
| transferWithAuthorization tx | `0xff8a175e...51ccbf5` (block #27,918,011) |

### 链上验证

```
Agent: 1000.0 → 999.0 USDC
Merchant: 0.0 → 1.0 USDC
Nonce 状态: used ✅
端到端 settlement cost: 0.0000000824 HSK
```

### 协议代码层 100% 兼容 AgentCore Payments x402 路径

```diff
# 业务代码唯一差别：
- chainId: 84532       # Base Sepolia
- usdc:    0x036cbd...  # Coinbase USDC
+ chainId: 133          # HashKey Chain Testnet
+ usdc:    0x0685c4...  # Mock USDC (含完整 EIP-3009)
```

**协议、SDK、Strands Agent、Lambda 后端、AWS 服务调用——全部不变。**

---

## 六、给 HashKey 客户的 5 层 narrative

```
第 1 层 — 现在能跑通的（demo 主体）
  "我们在 HashKey Chain Testnet 上部署了 mock USDC（含完整 EIP-3009）。
   Strands Agent 调付费工具，自动签 EIP-712 + 在 HashKey Chain 链上结算，
   整个流程跟 Coinbase CDP + Base Sepolia 完全一致。Blockscout 链接可查。"

第 2 层 — 等链上 USDC 上线即可演进的
  "等 Circle 把官方 USDC 部到 HashKey Chain，把合约地址换一下就是生产级。
   这个改动是分钟级的工作，因为协议层和合约接口都已经对齐 EIP-3009 标准。"

第 3 层 — 跟你们直接相关的
  "你们正在做的 HKDR（港币稳定币）一旦上线，
   只要遵循 EIP-3009 标准，OpenAgentPay 自动支持。
   香港的 Agent 经济可以用港币结算，不需要绕一圈 USD。"

第 4 层 — Tier 2 演示
  "我们也支持 WHSK 原生支付——但只推荐给大额场景，
   因为 HSK 价格波动让微支付不稳定。"

第 5 层 — 跟 HashKey Pro 交易所打通
  "v0.2 我们支持你们的 HashKey Pro Sandbox API（CEX-internal 路径），
   适合需要 KYC 的 B2B 场景。"
```

---

## 七、四个 AWS sample repo 的位置

| Repo | 关系 | 用法 |
|---|---|---|
| **#1 sample-agentcore-cloudfront-x402-payments** | **同事 demo 的来源**（高置信度）| Fork 改造或参考其架构 |
| **#2 sample-secure-agentic-payments-on-aws-x402** | "Spend Governor" 治理层灵感 | `PaymentAdapter` ABC 抽象 = 我们的 `WalletConnector` 雏形 |
| **#3 sample-serverless-digital-asset-payments** | "ETH + 任意 ERC20" 通用收款 | 证明非 USDC 资产可行 |
| **#4 sample-agentic-serverless-payments** | "在 Agent tool 内部签名" 模式 | **逃逸阀**：如果 AgentCore Payments 不开放 BYO，我们走 CDP AgentKit 风格 |

---

## 八、监控 AWS 路线图的关键信号

| 信号 | 含义 | 我们的反应 |
|---|---|---|
| AWS GA 时开放 `CreatePaymentConnector` 新 type | BYO wallet 接口开放 | 立刻把 OpenAgentPay 的 connector 注册进去 |
| HashKey 在 AWS GA 时被加进 enum | AWS 自己接了 HashKey | OpenAgentPay HashKey connector 转为 reference impl，重心转其他 wallet |
| Circle 在 HashKey Chain mainnet 部 USDC | 真 USDC 可用 | 把 mock USDC 替换成官方 USDC，0 改动 |
| HKDR 上线 | 港币稳定币真上线 | 立刻加进 Tier 1，配合 HashKey 客户做亚洲合规演示 |
| AgentCore Payments 出 BYO sample | 官方推 BYO 模式 | 与 AWS Solution Architect 团队对齐 |

---

## 九、实施路线图（精确到 commit）

> 注：Phase 命名是技术 milestone 标号，不是时间表。下面状态是 2026-05-17 截止的实际完成情况。

| Phase | 任务 | 状态 | 关键产出 |
|---|---|---|---|
| W0 | 项目脚手架 | ✅ commit `afab429` | Apache 2.0 + monorepo |
| W1 | Binance Pay e2e | ✅ commit `08aed9c` | 50 TS + 8 Python tests |
| **HashKey** | **Mock USDC + EIP-3009** | ✅ **2026-05-17** | **链上 e2e 跑通** ⭐ |
| Phase A | 战略固化 | ✅ 完成 | STRATEGY.md（本文）+ HASHKEY_DEMO.md |
| Phase B | core 接口对齐 AgentCore | ✅ 完成 | `PaymentManager`/`PaymentConnector`/`PaymentInstrument`/`PaymentSession` 命名 |
| Phase C | HashKey TS Connector | ✅ 完成 | `packages/wallet-hashkey/` (23 tests) |
| Phase D | Facilitator Lambda | ✅ 完成 | CDK + us-east-1 部署，Lambda Function URL |
| Phase E | DDB SessionManager | ⏳ 按需 | 当前 InMemory 够用；需要多实例时再加 |
| Phase F | API 后端 | ✅ 完成 | `/api/wallet`, `/api/session`, `/api/pay`, `/api/health` |
| Phase G | 三 Tab Web UI | ✅ 完成 | apps/demo-web 三 Tab |
| Phase H | 部署 + e2e | ✅ 完成 | CloudFront + S3 + Lambda live: https://d1p7yxa99nxaye.cloudfront.net |
| Phase I | 文档 + 视频 | 🚧 部分完成 | README v2 ✅ + STRATEGY/QUICKSTART/PRESENTATION ✅ + 5min demo 视频 ⏳ + 中英博客 ⏳ |

---

## 十、不做的事（边界声明）

- ❌ 我们**不写超过 1-2 个钱包的 production-grade connector**——其他钱包让钱包商自己写（Linux Foundation 模式）
- ❌ 我们**不做支付收款侧（merchant）**——专注 Agent 买方侧，跟 Visa/Mastercard 互补
- ❌ 我们**不和 AgentCore Payments 竞争**——路径 D 让两者并存
- ❌ 我们**不做监管 / 合规 / KYC 实现**——交给底层钱包商（HashKey/Binance 自己持牌）
- ❌ 我们**不做主网真金白银**直到 v1.0 GA——testnet 优先
- ❌ 我们**不绑死任何单一稳定币**——Tier 1 多币种是核心差异化

---

## 十一、风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| AWS 抢先开放 BYO 钱包 | 中 | 我们的 connector 形态对齐 AgentCore，反而成为 day-1 implementation |
| HashKey 工程团队自建类似方案 | 中 | 我们先做 + 公开 + 找他们 review，姿态高 |
| Circle 在 HashKey Chain 不部 USDC | 低 | 用 HKDR / mock USDC / WHSK 都可以替代 |
| Strands Agent SDK 接口变化 | 中 | pin 到稳定版本，关注 AgentCore Payments 官方 sample |
| 协议层（x402 v2）破坏性变更 | 低 | x402 Foundation 治理保证向后兼容 |

---

*Last updated: 2026-05-17 21:00*
