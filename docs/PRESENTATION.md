# OpenAgentPay × HashKey Chain — Presentation Kit

> **For Neo's talk · 2026-05-18**
> **Live demo URL**：https://d1p7yxa99nxaye.cloudfront.net （**Live!** 演讲台上直接打开）
>
> 这份文档包含 4 件东西：
> 1. 演讲大纲（10-15 min）
> 2. Demo Tour 脚本（每个 Tab 演示什么 + 说什么）
> 3. Talk Points 卡片（关键 5 点）
> 4. 备份方案 + Q&A

---

## 0️⃣ 一句话定位

> "OpenAgentPay 是 AWS Bedrock AgentCore Payments 的开放扩展层——让任何钱包、任何稳定币、任何链都能即插即用接入。今天我们用 HashKey Chain Testnet 演示一个完整的端到端 demo，所有交易**链上真实可查**。"

---

## 1️⃣ 演讲大纲（建议 12 分钟，5 段）

### 段 1（90 秒）— 问题陈述

> **核心信息**："AWS AgentCore Payments 上周发布 Preview——这是云厂商第一次在 Agent 平台层提供原生支付能力。但当前只支持 Coinbase CDP + Stripe Privy 两个钱包 + x402 一个协议。这对亚洲客户、特别是 HashKey 这样的合规交易所、未来想推 HKDR 港币稳定币的客户——**完全不可用**。"

🎯 关键数字：**4 个 region（无亚洲）· 2 个钱包（无亚洲）· 1 个协议**

### 段 2（90 秒）— 我们的方案

> "我们做了 **OpenAgentPay**——一个开源的可插拔扩展层。**类比 Kubernetes 的 CRI 时刻**：定义 WalletConnector + ProtocolAdapter 两个标准接口，让任何钱包、任何协议都能即插即用接入 AgentCore。
>
> 战略上我们不和 AWS 竞争——**保留 AgentCore 的 Runtime/Identity/Gateway/Observability 不动，只替换 Payments 模块的 Wallet 层**。客户用 Coinbase 走原版 AgentCore Payments，用 HashKey 走我们的扩展。前端下拉切换，业务代码 1 行不改。"

🎯 关键概念：**路径 D 混合方案** — AWS 路径不动，扩展层并存

### 段 3（5 分钟）— Live Demo（这段最重要）

> 打开浏览器到 https://d1p7yxa99nxaye.cloudfront.net
>
> "现在这个 demo 跑在 **AWS us-east-1 上的 Lambda + CloudFront + S3**，钱包私钥在 **Secrets Manager（KMS 加密）**。我演示三件事——"

参考 §2 Demo Tour 脚本

### 段 4（90 秒）— 链上事实证据

> "重点：这不是 mock。我们已经在 HashKey Chain Testnet 上做了：
>
> - 一份 **mock USDC 合约**部署，包含完整 EIP-3009 transferWithAuthorization
> - 三笔真实链上交易（Python ref 实现 + TypeScript 实现 + 刚才 demo 跑的）
> - 链上每笔都在 https://testnet-explorer.hsk.xyz 上 immutable 可查
>
> Python 和 TypeScript 两套独立实现产生**完全相同的链上效果**——证明协议层抽象正确。"

🎯 关键数据：**MockUSDC `0x0685C4...` · 3 笔真链上 tx · gas 0.0000000824 HSK/笔**

### 段 5（120 秒）— 为什么这对 HashKey 重要 + 路线图

> "这套架构对 HashKey 客户的 5 层价值：
>
> 1. **现在能跑通的**：mock USDC 在 HashKey Testnet 链上结算
> 2. **下一步可演进的**：等 Circle 把官方 USDC 部到 HashKey Chain，换合约地址即可——分钟级改动
> 3. **跟 HashKey 直接相关的**：HKDR 港币稳定币上线后自动支持，不需要改协议
> 4. **WHSK 路径**：原生 HSK 也能 wrap 后做支付（适合大额场景）
> 5. **HashKey Pro 路径**：接 CEX-internal API（适合 KYC 合规场景）
>
> 这就是给亚洲 FSI 客户的完整 narrative。"
>
> "下一步：接 Strands Agent 真实推理 + 加 Coinbase CDP/Stripe Privy 走 AgentCore Payments 原版作对照演示——这两件事都是已知的工程量，按需求触发。"

---

## 2️⃣ Demo Tour 脚本（4-5 分钟逐 Tab）

> 浏览器：**https://d1p7yxa99nxaye.cloudfront.net**

### 🟣 Tab 1：Run Demo (90 秒)

**先讲一句**："先看 4 步手动跑通链上结算的过程——每一步都对应 OpenAgentPay 内部一个 component。"

**演示动作 + 旁白**：

1. **指 sidebar 的 Wallet Status**："你看左边——agent 钱包地址 `0x863d...`，余额 997.9 USDC，这都是从 HashKey Chain 真链上读的。"
2. **点 Step 1 Run** → "这个调 `/api/wallet`，CloudFront 转发到 Lambda，Lambda 用 viem 查 HashKey Chain RPC——0.5 秒返回。"
3. **点 Step 2 Run** → "创建一个 Payment Session，预算 $1，60 分钟过期——这是 spend governor 的边界，超预算硬拒绝。"
4. **点 Step 3 Pay** → "这是核心步骤——签 EIP-712 typed data，Facilitator 上链。等 5 秒——"
5. **指 tx hash 链接** → "这就是真上链的证据。点开 Blockscout——"
   👉 **打开 tx 链接**："block 号、gas、payer、recipient——immutable 可查。"
6. **回到 demo 点 Step 4 Run** → "Session 已经扣了 0.001 USDC。这是 audit trail。"

**关键说法**：
- "这一笔交易，从浏览器到链上落地，全程 ~5 秒。"
- "这个 demo 的钱包私钥**没有暴露在代码里**——它在 AWS Secrets Manager，KMS 加密，Lambda 用 IAM role 取。"

### 🟣 Tab 2：How It Works (60 秒)

**先讲一句**："如果你想理解全链路 8 步，这个 tab 直观——"

**演示动作 + 旁白**：

1. **依次点击 Step 4、Step 6、Step 7** → 让右侧详情显示
2. **重点讲 Step 6**："EIP-712 签名——这就是 x402 协议的灵魂。**和 AgentCore Payments 在 Base Sepolia 上跑的代码是 100% 同一份**——只是链换了。"
3. **重点讲 Step 7**："Facilitator 替 Agent 上链。Agent 自己不需要持有 gas。这是给 Agent-as-a-service 场景的关键——AI Agent 不该和 gas 经济管理打交道。"

**关键说法**：
- "8 步里我们扩展的就是 Step 5 (CREDS) 和 Step 6 (SIGN)——其他都是 AWS AgentCore Payments 的标准设计。"

### 🟣 Tab 3：AI Agent (60 秒)

**先讲一句**："最后这个 tab 模拟 Strands Agent 自主决策——下一步真接 Bedrock 后会更精彩。"

**演示动作 + 旁白**：

1. **指 3 个工具卡片** → "Agent 拥有这 3 个工具：1 个免费、2 个付费。"
2. **点 "BTC 行情"按钮** → "免费 prompt——Agent 用 free tool 就够了，钱包不动。"
3. **点 "ETH 深度分析"按钮** → "这个会触发**真上链 0.001 USDC 结算**——agent 决策、付费、拿到结果。"
4. **结果出来后** → "这就是给 HashKey 客户演示的最终形态：AI Agent 在亚洲合规链上做微支付。"

---

## 3️⃣ Talk Points 卡片（演讲台上一眼看的关键点）

### 5 个关键数字
1. **357 秒** — CDK 一键部署完整 demo
2. **5 秒** — 端到端结算时间（含上链确认）
3. **0.0000000824 HSK** — 单笔结算 gas 成本（比 Base Sepolia 还低）
4. **3 笔真上链 tx** — Python、TS、Live 各一笔，全部可在 Blockscout 查
5. **路径 D 混合** — Coinbase 走 AWS 原版，HashKey 走我们扩展，前端切换

### 5 个关键说法（cue 卡）

✅ "**协议层与 AgentCore Payments 100% 兼容**——业务代码改一行 `wallet_provider` 即可"

✅ "**Python 和 TypeScript 两套独立实现产生完全相同的链上效果**——证明协议抽象正确"

✅ "**链上每笔都在 testnet-explorer.hsk.xyz immutable 可查**——这不是 mock"

✅ "**等 Circle 在 HashKey Chain 部官方 USDC，把合约地址换一下就是生产**"

✅ "**HKDR 港币稳定币上线后自动支持**——你们的客户能用港币结算"

### 5 个**不要**说

❌ 不要说"替代 AgentCore Payments"——说"扩展"
❌ 不要说"商业级生产可用"——说"协议层 verified，UI/AWS 部署是 Phase 2"
❌ 不要说"AWS 不支持亚洲"——说"AWS 当前 Preview 阶段聚焦美/欧"
❌ 不要承诺 HashKey 公司参与——说"开放贡献，钱包商可自己接入"
❌ 不要说"竞品"——说"AWS 是同盟，互补"

---

## 4️⃣ 演讲台上的 URL Cheatsheet

### 主 URL（最重要，第一个打开）
```
https://d1p7yxa99nxaye.cloudfront.net
```

### Blockscout 链上证据（演讲时随时打开展示）
```
合约：    https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803
Python:   https://testnet-explorer.hsk.xyz/tx/0xff8a175e3f4b41a30b67940a4b654d7791742d76421d53a33dd976e8a51ccbf5
TypeScript: https://testnet-explorer.hsk.xyz/tx/0x5c10e2ae5a152169c5870ce440f7ee2c5bbd26410690d8424af79d547df5f098
Lambda 上链：https://testnet-explorer.hsk.xyz/tx/0xd18cb0f19359bdaae17aa89a0e14c47ccb7793579b9a09ac0423eefb1390a06a
```

### GitHub 仓库（开源证据）
```
https://github.com/neosun100/openAgentPay
```

### 备份 URLs（万一主 URL 出问题）
```
Lambda 直连（绕过 CloudFront）：
https://yxhi4anykqinsxszhyi4z5icdq0usfmv.lambda-url.us-east-1.on.aws/api/health
```

---

## 5️⃣ 备份方案（如果 demo 卡了）

### 方案 A：CloudFront 缓存问题
- 直接用 Lambda URL 测试 API：`https://yxhi4anykqinsxszhyi4z5icdq0usfmv.lambda-url.us-east-1.on.aws/api/wallet`

### 方案 B：HashKey RPC 卡顿
- 解释："HashKey Testnet RPC 偶尔会卡——这是 testnet 节点问题，不是协议问题。让我们看本地跑过的截图——"
- 备好 `docs/screenshots/04-run-demo-after-pay.png` （已经有）

### 方案 C：Lambda 冷启动
- 第一次请求可能 2-3 秒（Secrets Manager 读取）
- 在演讲前 10 分钟先点一下 `/api/wallet` 把 Lambda 预热

### 方案 D：完全回退到本地 demo
- 笔记本预备 `pnpm demo` 启动 + .env.local 已配好
- 说："今天 production 网络不稳定，看本地一样的代码——"
- 演示效果完全一致

---

## 6️⃣ Q&A 预案

| 问题 | 答案要点 |
|---|---|
| **"既然 x402 这么好，为什么 Binance 不直接用 x402？"** | "x402 是**链上协议**——要求 EIP-712 签名 + EIP-3009 ERC-20 合约 + 公链 settlement。Binance / OKX / Bitget 这些 CEX **结构上不上链**，让中心化数据库假装成 ERC-20 合约既笨拙又违背 CEX 的低成本优势。所以我们做了 **OAP-CEX 协议**——保留 x402 的形状（402 challenge → sign → retry），但**签名层换成 HMAC**（CEX 标准），**结算层换成 CEX 内部记账**。两个协议共享 ProtocolAdapter 接口，业务代码层面只换一行 walletProvider。" |
| "AWS 会不会自己接 HashKey？" | "Roadmap 写了 'Others* Coming soon'。我们的接口设计就是为了那一天——AWS 开放后我们 connector 直接 register 进去" |
| "为什么不用 Coinbase x402 facilitator？" | "可以的，OpenAgentPay 协议层兼容。但 testnet 上自跑 facilitator 更可控，避免 nonce 冲突等问题" |
| "私钥放 Lambda 安全吗？" | "私钥在 Secrets Manager + KMS encrypted at rest，Lambda 用 IAM role 取，不写 code、不写 log" |
| "性能怎么样？" | "5 秒端到端，跟 Base Sepolia 同量级。HashKey Chain 出块比 Base 还快一点" |
| "HKDR 什么时候上？" | "HashKey 自己路线图，我们做好 plug 准备。EIP-3009 兼容的任何 ERC20 都即插即用" |
| "Strands Agent 真接了吗？" | "Tab 3 当前是 mock UI。下一步会接 Bedrock + Strands。**接通后业务代码不用改**——只是 plugin 配置不同" |
| "怎么开源贡献？" | "Apache 2.0 + GitHub。新钱包商按 PaymentAdapter ABC 接口实现 connector，过 conformance test 即可发 npm" |
| "和 Stripe MPP 是什么关系？" | "MPP 是 Stripe + Tempo 的 IETF Internet-Draft，向后兼容 x402。我们的 ProtocolAdapter 抽象天然支持——按需求触发就能加" |

---

## 7️⃣ 演讲前 30 分钟 checklist

- [ ] 打开 https://d1p7yxa99nxaye.cloudfront.net 预热 Lambda（点一下 Run Step 1）
- [ ] 检查钱包还有 HSK gas（去 https://faucet.hsk.xyz/ 看 `0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7`）
- [ ] 检查 USDC 余额还充足（≥ 990 USDC，如果 < 100 需要再 mint）
- [ ] 浏览器 5 个 Tab 备好：
  1. https://d1p7yxa99nxaye.cloudfront.net
  2. https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803
  3. https://github.com/neosun100/openAgentPay
  4. 这份 PRESENTATION.md
  5. 备用 Lambda URL
- [ ] 笔记本预备本地 demo：`pnpm demo`（备份）
- [ ] 网络备用：手机热点
- [ ] 做一次完整演练（10 分钟，时间感对齐）

---

## 8️⃣ 演讲后跟进

- 如果有 HashKey 工程对话意向：发 GitHub repo + 这份 PRESENTATION.md
- 如果有 AWS Solution Architect 同事兴趣：发 STRATEGY.md
- 如果有客户问 v0.2 时间表：发 docs/REFERENCES.md（路线图清晰）

---

*Prepared by Neo Sun + OpenAgentPay × Kiro · 2026-05-17 22:10*
*Status: live + ready · Last on-chain tx: 0xd18cb0f19359...390a06a*
