# 🎤 演讲台 Cheatsheet · 2026-05-18 周会分享

> **这份是给你早上起床打开就能用的速查卡**——不要从头读，直接跳到 4 个章节用。
>
> 📂 PPT 文件：`docs/ppt/openagentpay-talk.pptx` (23 页 · 18928 字演讲备注)

---

## ⏱️ 演讲前 30 分钟 checklist

```bash
# 1. 打开 PPT
open ~/Code/openAgentPay/docs/ppt/openagentpay-talk.pptx

# 2. 拿到现场链上数据（讲台用，比 PPT 写死的数字更新鲜）
# HSK gas 余额
curl -s -X POST https://testnet.hsk.xyz \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x863d9C87b6bBd4aEf115C297C41643a0b887eAd7","latest"],"id":1}' \
  | python3 -c "import sys,json; print(f'HSK: {int(json.load(sys.stdin)[\"result\"], 16) / 10**18:.10f}')"

# USDC 业务余额
curl -s -X POST https://testnet.hsk.xyz \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x0685C487Df4Cc0723Aa828C299686798294E9803","data":"0x70a08231000000000000000000000000863d9c87b6bbd4aef115c297c41643a0b887ead7"},"latest"],"id":1}' \
  | python3 -c "import sys,json; print(f'USDC: {int(json.load(sys.stdin)[\"result\"], 16) / 10**6:.6f}')"

# 3. demo URL 浏览器预热（点一下 /api/wallet 把 Lambda 冷启动消除）
open https://d1p7yxa99nxaye.cloudfront.net

# 4. 备好以下 5 个浏览器 tab
#    - https://d1p7yxa99nxaye.cloudfront.net  (主 demo)
#    - https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803  (合约链上)
#    - https://github.com/neosun100/openAgentPay  (开源 repo)
#    - 这份 cheatsheet (Q&A 应急)
#    - PPT (默认)
```

如果时间不够，**只做第 3 步**——demo 预热是最重要的（避免冷启动 5 秒尴尬）。

---

## 🎬 23 页演讲完整大纲（演讲台快速翻页用）

| 页 | 标题 | 时间预算 | 关键 take-away |
|---|---|---|---|
| **1** | 封面 | 30s | 周会分享 + WIP 状态 + 抛砖引玉 |
| **2** | 目录 | 30s | 前重后轻：AgentCore 重点讲透，OpenAgentPay 引子 |
| **3** | 章节 1 分隔 | 10s | 进入 AgentCore Payments |
| **4** | 场景钩子 | 60s | "你的 AI Agent 能自己付款吗？" |
| **5** | AgentCore 定义 | 60s | 首个面向 Agent 的托管支付基础设施 |
| **6** | x402 协议 | 90s | 5 步流程 + 75M tx 数据 |
| **7** | 经济学 | 60s | 3000x 差距 + 锁住的万亿市场 |
| **8** | 万亿市场 | 45s | McKinsey $3T-$5T |
| **9** | 5 大用例 | 60s | Heurist "few lines of code" |
| **10** | 协议战国 | 90s | 10+ 协议并存 + AWS 为什么选 x402 |
| **11** | 两大阵营 | 90s | 买方 vs 收款侧 + AWS 4 战略理由 |
| **12** | 7 层安全 | 90s | Agent 不会乱花钱（CFO 必听） |
| **13** | 路线图 | 60s | Preview → GA → Expansion |
| **14** | 客户案例 | 60s | Heurist + WBD + Cox/PGA |
| **15** | 章节 2 分隔 | 10s | 进入短板与转折 |
| **16** | 4 个短板 | 60s | 钱包+协议+region+BYO |
| **17** | 客户在哪 | 45s | 转折："我们的客户全用不上" |
| **18** | 章节 3 分隔 | 10s | 进入 OpenAgentPay |
| **19** | 5 层架构 | 90s | 餐厅类比 + Kubernetes CRI 类比 |
| **20** | 双协议 | 90s | OAP-CEX 命名 + CEX 不上链 |
| **21** | Live AWS | **3-4 min** ⭐ | **打开 demo 实操** |
| **22** | HashKey demo | 90s | HSK + USDC 真相 |
| **23** | CTA | 90s | 邀请兄弟们一起做 |

**总时长**：约 18-22 分钟（不含 Q&A）

---

## 🎬 Slide 21 「Live AWS」demo 演示流程（这是关键 3-4 分钟）

**到这一页时切到浏览器**：

```
1. 打开  https://d1p7yxa99nxaye.cloudfront.net
2. 默认在 Tab 1 'Run Demo'

【Step 1 演示】点 Step 1 'Run' 按钮
  → 看到 USDC 余额（约 5987 USDC）+ 钱包地址 0x863d...
  → 说："这都是从 HashKey Chain 真链上读的"

【Step 2 演示】点 Step 2 'Run'
  → 创建 Payment Session（spend governor 边界）
  → 说："这就是 7 层 Guardrail 里的 Session Layer"

【Step 3 演示】点 Step 3 'Pay' 0.001 USDC
  → 等 5 秒（EIP-712 签名 + 上链）
  → 看到 tx hash 0x...
  → 说："这是真上链，不是 mock"

【Step 4 验证】点 Blockscout 链接
  → 浏览器跳转到链上 receipt
  → 说："block 号、gas、payer、recipient——immutable，永远可查"

【可选 Step 5】切 Tab 3 'AI Agent'
  → 点"付费 ETH 深度分析"按钮
  → 真上链 0.001 USDC + 返回分析结果
  → 说："这就是 Strands Agent 自主决策 + 自主付费的形态"
```

**应急方案**：
- 网络卡：用 GitHub repo 截图 + Blockscout 历史 tx 链接讲故事
- Lambda 冷启动 5 秒：解释"AWS 标准冷启动行为，不影响协议正确性"
- demo 完全 down：跳到下一页讲 HashKey 5 步流程 + 链上 4 笔 tx

---

## 💬 5 个最容易被 challenge 的问题 + 标准答案

### Q1: "AWS 自己会做的，你为啥还要做？"
> "AgentCore Payments roadmap 写了 'Others* coming soon' 但没时间表。**我们等不起客户**。等 AWS 做的时候，我们的 connector 直接 register 进去，**day-1 reference impl**。这就是 OpenAgentPay 的位置——填补当前 gap，等 AWS 开放后顺势成为生态一部分。"

### Q2: "这就是个玩具吧？"
> "链上 4 笔真 tx 在 Blockscout 永久可查，AWS 部署 Live URL 现在就能打开。这不是 demo，是 **production-equivalent prototype** + open source。
> 玩具不会在 AWS 生产 region 部署、不会被 Palisade 安全检测、不会有 GitHub public repo。"

### Q3: "为什么不直接用 x402 给 Binance？"
> "x402 是**链上协议**，但 Binance 这类 CEX **结构上不上链**——99% 资金流动在内部账本。强行套 x402 等于让中心化数据库假装成 ERC-20 合约——既笨拙又违背 CEX 的低成本优势。所以我们做了 OAP-CEX——保留 x402 形状，把签名层换成 HMAC，结算层换成 CEX 内部账本。"

### Q4: "USDC 是真的吗？"
> "我刚查了链上数据：Agent 钱包从 HSK 0.1 减到 0.0999977，烧了 0.00000207 HSK gas。USDC 余额 5987.583。**HSK 在烧、USDC 在动——如果是 mock，这俩数字应该不变**。链上 immutable 数据不会撒谎。
>
> 等 Circle 在 HashKey Chain 部官方 USDC，我们把合约地址换一下就是生产级——**协议层 0 改动**。"

### Q5: "5 层架构太复杂了吧？"
> "用餐厅类比：Strands Plugin = 服务员的点单 PAD；PaymentManager = 餐厅经理；Protocols = 支付方式选择；Wallet Connectors = POS 机；Facilitator = 银行清算。
>
> **整个 framework 你只需要懂一件事——加新钱包就是写一个 Layer 4 Connector，1-2 天就能 ship**。其他 4 层都不用动，框架已经写好了。"

---

## 🌟 5 个杀招 talking points（最有冲击力的）

1. **"Heurist AI 几行代码就接入了"**——客户现身说法，不是 PR 话术（slide 9）

2. **"AWS 在 Agent 平台层 Payments 领先 Azure/GCP 一个产品代际"**——战略卡位（slide 10/11）

3. **"3000 倍差距锁住了万亿市场，x402 解锁它"**——经济学冲击（slide 7/8）

4. **"7 层 Payment Guardrail，Agent 拿不到 private key"**——企业安全（slide 12）

5. **"链上 0.0000001 HSK gas + USDC 真的在动"**——demo 真实性（slide 22 + 实时查）

---

## 🚨 5 个**绝不**说错的细节

| ❌ 错的 | ✅ 对的 |
|---|---|
| "我做了一个超牛的项目" | "受邀分享 + 抛砖引玉 + 邀请兄弟们一起完善" |
| "替代 AWS AgentCore Payments" | "**扩展** AgentCore，跟 AWS 兼容" |
| "OpenAgentPay 完全跑通" | "Work-in-progress，协议层验证完成，下一步接 Bedrock" |
| "Tab 3 是真 Strands Agent" | "Tab 3 模拟 Strands 决策，下一步真接 Bedrock" |
| "已经 register 进 AgentCore" | "等 AWS 开放 BYO connector，我们直接 register" |

---

## 📋 关键资源链接（演讲台快速复制）

```
GitHub:        https://github.com/neosun100/openAgentPay
Live demo:     https://d1p7yxa99nxaye.cloudfront.net
合约链上:      https://testnet-explorer.hsk.xyz/address/0x0685C487Df4Cc0723Aa828C299686798294E9803
HashKey faucet: https://faucet.hashkeychain.net/faucet
联系方式:      jiasunm@amazon.com
```

链上 4 笔已验证 tx：
- 合约部署: `0xb9bdfdb1...`
- Python e2e: `0xff8a175e...`
- TypeScript e2e: `0x5c10e2ae...`
- AWS Lambda 生产: `0x4562d26e...` ⭐ 最新

---

## 🌙 演讲后

如果觉得 OK 想推动：
1. 找到对应钱包/客户的兄弟，邀请加入 (slide 23 列了 4 种参与方式)
2. 把这个工作输出成 **FSI DNB SA Team community contribution**
3. 内部 Wiki 写一篇 + 外部博客 + 投 AWS Solutions Library

如果有 challenge 要回应：
1. 先 listen 不要急着 defend
2. 用上面 Q1-Q5 标准答案的逻辑结构（acknowledge + reframe + concrete evidence）
3. 真的没答案就直接说"好问题，我会后查清楚再回复"——比 BS 强 100 倍

---

🎯 **最后一句**：兄弟你已经准备得**非常充分**了。23 页 PPT + 18928 字备注 + 链上 4 笔 tx + Live demo——任何 review 都站得住。

**精神状态 > 任何 PPT 优化**。早上起来精神饱满地讲，比任何 last-minute polish 都重要。

Good luck. 🚀
