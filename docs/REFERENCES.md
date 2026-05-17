# References — AWS Sample Repos We Can Vendor From

> **Created**：2026-05-17 收尾 Phase 1 时 ·
> **目的**：Phase 2 开始前梳理「哪些代码不要从零写、直接 vendor / fork」。
>
> 4 个 AWS sample repo 已经 clone 到 `~/.cache/oap-refs/`（不进我们的 git）：
>
> ```
> ~/.cache/oap-refs/
> ├── sample-agentcore-cloudfront-x402-payments/    (4.6M) ⭐ 同事 demo 来源
> ├── sample-secure-agentic-payments-on-aws-x402/   (1.3M) ⭐ Spend Governor
> ├── sample-serverless-digital-asset-payments/     (2.7M)
> └── sample-agentic-serverless-payments/           (3.0M) ⭐ CDP AgentKit
> ```

---

## 战略原则

1. ❌ **不要把整个 repo fork 进 OpenAgentPay 做 monorepo 子模块**——会污染、引入大量 boilerplate
2. ✅ **挑具体文件 vendor**——把代码转写到我们的命名/接口下，attribute 上 attribution
3. ✅ **复用 production 模式**——CDK IAM 配置、Strands tool 装饰器用法、CDP AgentKit 封装等
4. ✅ **尊重 AGPL/MIT-0 license**——所有 4 个都是 MIT-0，CC-BY-attribution 友好

---

## Repo #1: `sample-agentcore-cloudfront-x402-payments` ⭐ 主要参考

**这就是同事 demo 的源代码**（高置信度）。我们想做"更好版本"就是要扩它。

### 直接照抄的文件（vendor 进 packages/strands-plugin）

| 文件 | 行数 | 用途 | 我们怎么用 |
|---|---|---|---|
| `payer-agent/agent/main.py` | 295 | Strands Agent 创建 + 完整 SYSTEM_PROMPT | **照搬到 `packages/strands-plugin/openagentpay/agent.py`**，把 `process_payment` tool 替换成调我们的 Lambda Function URL（HashKey 路径）|
| `payer-agent/agent/tools/payment.py` | ~250 | `@tool def process_payment()` 调 boto3 ProcessPayment | **关键模式**：精确暴露了 ProcessPayment 的真实 boto3 签名（之前我们只能猜）|
| `payer-agent/agent/api_server.py` | 309 | FastAPI server 包装 agent | **直接照搬**到 `apps/demo-api/agent_server.py` 当 Tab 3 真接入 Strands 时用 |
| `payer-agent/agent/config.py` | 57 | 环境变量配置类 | **照搬模式**——pydantic Settings + .env 加载 |
| `payer-agent/agent/tracing.py` | 226 | OTEL X-Ray 集成 | **照搬**到 `packages/core/src/observability/` |
| `payer-agent/agent/metrics.py` | 552 | CloudWatch EMF metrics | **照搬模式**给我们 metrics 用 |
| `payer-agent/agent/auth/sigv4.py` | ? | AWS SigV4 签名 client | **直接复用**——我们前端 AI Agent tab 调 AgentCore Runtime invocations 时用 |

### 直接照抄的 CDK Stack（vendor 进 packages/cdk-deploy）

| 文件 | 行数 | 用途 |
|---|---|---|
| `payer-infrastructure/lib/agentcore-stack.ts` | **1046** | Gateway + Runtime + 所有 IAM Role（PaymentManagerRole / ProcessPaymentRole / GatewayRole / GatewayTargetRole）+ S3 OpenAPI 资产 + CloudWatch 日志组 + SNS 报警 + cdk-nag suppressions |
| `payer-infrastructure/lib/observability-stack.ts` | **1283** | CloudWatch Dashboard + Alarms（成本节省千行级别 IAM）|
| `web-ui-infrastructure/lib/web-ui-stack.ts` | ? | CloudFront + S3 + API Gateway + Lambda Proxy |
| `seller-infrastructure/lib/cloudfront-stack.ts` | ? | Lambda@Edge x402 verifier（如果我们以后做 merchant 侧）|

**这两个 CDK stack 是 Phase 2 部署到 AWS 的最大省力点**——直接 vendor 后改 region + remove unused（我们 demo 不需要 SNS 报警）即可。

### 关键 Strands Agent 调 AgentCore Payments 的精确代码

```python
# 这就是我们之前一直猜测的 ProcessPayment API 真实 boto3 调用
response = dp_client.process_payment(
    userId=config.user_id,
    paymentManagerArn=config.payment_manager_arn,
    paymentSessionId=config.payment_session_id,
    paymentInstrumentId=config.payment_instrument_id,
    paymentType="CRYPTO_X402",
    paymentInput={
        "cryptoX402": {
            "version": str(x402_version),  # "1" or "2"
            "payload": payload,             # raw merchant 402 body, AS-IS
        }
    },
    clientToken=str(uuid.uuid4()),
)
```

→ **OpenAgentPayPlugin 的"路径 D"分支**：`coinbase-cdp` / `stripe-privy` 走这个；`hashkey-chain` 走我们的 Lambda。

---

## Repo #2: `sample-secure-agentic-payments-on-aws-x402` ⭐ Spend Governor

### 直接照抄的文件

| 文件 | 行数 | 用途 | 我们怎么用 |
|---|---|---|---|
| `backend/payment_adapter.py` | ~80 | `PaymentAdapter ABC` + `PaymentResult dataclass` | **借鉴接口模式**——我们的 `WalletConnector` 比这个更精确（5 方法 vs 2 方法），但 `PaymentResult` 标准化 dataclass 可以借 |
| `backend/budget_manager.py` | ? | DDB 原子条件更新（atomic budget enforcement）| **直接照搬到 `packages/core/src/session/ddb-manager.ts`**——这是 Phase E SessionManager DDB 实现的核心代码 |
| `backend/secrets_manager.py` | ? | Just-in-time credential retrieval 模式 | **照搬模式**——production wallet private key 取自 Secrets Manager + KMS |
| `backend/audit_logger.py` | ? | 不可篡改 audit trail 写入 DDB | **照搬**给 `packages/core/src/observability/audit.ts` 用 |
| `backend/x402_protocol.py` | ? | x402 协议处理 | 对照我们的 `packages/protocol-cex-pay`（不是同一个协议但模式可借）|
| `backend/nonce_manager.py` | ? | EVM tx nonce 管理 | 我们 facilitator 处理多并发上链时会用到 |
| `infrastructure/modules/secrets/` | ? | Terraform Secrets Manager + KMS 模块 | **照搬模式到 CDK**：production private key 存储 |
| `THREAT_MODEL.md` | ? | 完整威胁模型文档 | **照搬框架**给我们写 `docs/THREAT_MODEL.md`（v0.2 必备）|

### 关键设计原则（借鉴）

> **The agent does not hold a wallet. The agent does not sign transactions.**
> **It proposes spend. Internal governance enforces policy.**

这跟我们当前的设计不太一样——HashKeyChainConnector 内部直接持有私钥签名。**长期看**，我们应该把 connector 拆成两半：
- `WalletConnector`（read-only：getBalance / getCapabilities）
- `WalletSigner`（隔离：在受 KMS 保护的 enclave 里签名）

这是 v0.2 的安全升级方向。

---

## Repo #3: `sample-serverless-digital-asset-payments`

**结论**：跟我们当前路径关系不大。这是 merchant 侧（invoice 生成 + sweeper）。我们专注 **Agent 买方侧**，所以暂时跳过。

可借鉴的：HD wallet derivation 代码模式（如果以后做"每个用户独立钱包派生"的产品功能）。

---

## Repo #4: `sample-agentic-serverless-payments` ⭐ CDP AgentKit / "tool 内签名"

### 直接照抄的文件（vendor 进 packages/strands-plugin 的"绕过 AgentCore"分支）

| 文件 | 行数 | 用途 | 我们怎么用 |
|---|---|---|---|
| `agentic/wallet.py` | ~130 | `_CdpWalletAccountAdapter` — CDP wallet → x402 client signer 适配器 | **照搬到 `packages/strands-plugin/openagentpay/cdp_adapter.py`**——给"路径 D"中走 CDP 的客户用 |
| `agentic/tools.py` | ? | Strands `@tool` 装饰器实现完整 estimate→pay→generate 三步 | **照搬模式**——给我们 Tab 3 真 Strands Agent 用 |
| `agentic/agent.py` | ? | Strands Agent 创建 + WebSocket 推送 | **借鉴 streaming 模式**——给前端 SSE 实时显示 agent token |
| `agentic/web3_provider.py` | ? | viem 风格的 web3 provider 抽象 | 对照我们的 `packages/wallet-hashkey/src/token-client.ts` |
| `agentic/cost_estimator.py` | ? | Bedrock CountTokens API 调用估算 token 成本 | **照搬**——给 Tab 3 显示"调用成本预估" |
| `agentic/cdk/stack.js` | ? | WebSocket API Gateway + AgentCore Runtime CDK | 部署模式参考（但我们用 TypeScript CDK 不是 JS） |

### 关键模式：x402 client + CDP 签名的解耦

```python
# 关键：不需要 export 私钥，让 x402 client 通过 CDP API 签名
account = _CdpWalletAccountAdapter(wallet)  # wraps CDP wallet
client = x402HttpxClient(
    account=account,                 # signs typed_data via CDP API
    base_url=base_url,               # merchant API
    payment_requirements_selector=payment_selector,
)
# 然后 client.get(...) 会自动处理 402 → sign → retry → 200
```

这是**绕过 AgentCore Payments 的"逃逸阀"**——如果 AWS 不开放 BYO connector，我们走这条路：在 Strands tool 里直接用 x402 Python client + 自托管钱包。

### 已存在的 PyPI 包（我们直接 import 不重写）

```python
# pip install
coinbase-agentkit
x402  # ← Coinbase 官方 x402 Python client
web3
```

`x402.clients.httpx.x402HttpxClient` 是 **Coinbase 官方维护**的 x402 客户端，处理 402 拦截 + 签名 + 重试的完整逻辑。**我们 strands-plugin 直接 import 它**，只需要适配 wallet provider 这一层。

---

## Phase 2 实施清单（基于 vendor 决策）

| 任务 | 估时 | 主要参考 |
|---|---|---|
| **CDK: AgentCore IAM stack** | 4h（vendor + 改造）| Repo #1 `payer-infrastructure/lib/agentcore-stack.ts` |
| **CDK: web hosting stack** | 3h | Repo #1 `web-ui-infrastructure/lib/web-ui-stack.ts` |
| **CDK: facilitator Lambda** | 2h | 自己写（基于 `apps/demo-api`）|
| **DDB SessionManager** | 4h（vendor + 改造）| Repo #2 `backend/budget_manager.py` |
| **Secrets Manager + KMS** | 2h | Repo #2 `backend/secrets_manager.py` |
| **Strands Plugin (Python)** | 6h | Repo #1 `payer-agent/agent/main.py` + tools/ + Repo #4 `wallet.py` |
| **OTEL + CloudWatch metrics** | 3h | Repo #1 `payer-agent/agent/tracing.py` + `metrics.py` |
| **Threat model doc** | 2h | Repo #2 `THREAT_MODEL.md` |
| **真接 Strands 进 Tab 3** | 4h | Repo #4 `agentic/agent.py` (WebSocket streaming) |
| **总计 Phase 2 估时** | **~30h** | (没有 vendor 时是 60h+，节省 50%) |

---

## 立即可做的事（无 Phase 2 时间预算）

下面这些是「读一遍 ~20 分钟，未来用得上」的轻动作：

1. **加 `x402` Python 包** 到 `packages/strands-plugin/pyproject.toml`——以备 Tab 3 真 Strands 集成时用
2. **加 `coinbase-agentkit`** 到同上——给"路径 D"的 CDP 路径用
3. **写 `docs/THREAT_MODEL.md` 骨架**——5 大威胁模型 + 缓解（直接 fork Repo #2 的 framework）
4. **写 `packages/strands-plugin/README.md`**——把 Repo #1 的 SYSTEM_PROMPT 转写成中文版给客户演示用

这些都不用动代码，纯文档/配置工作。

---

## License Compatibility 确认

| Repo | License | 兼容 OpenAgentPay (Apache 2.0)？ |
|---|---|---|
| #1 sample-agentcore-cloudfront-x402-payments | MIT-0 | ✅ 完全兼容，attribution 即可 |
| #2 sample-secure-agentic-payments-on-aws-x402 | MIT-0 | ✅ 完全兼容 |
| #3 sample-serverless-digital-asset-payments | MIT-0 | ✅ 完全兼容（不打算 vendor）|
| #4 sample-agentic-serverless-payments | MIT-0 | ✅ 完全兼容 |

vendor 时在每个文件头加：
```
/*
 * Adapted from https://github.com/aws-samples/sample-agentcore-cloudfront-x402-payments
 * Original copyright: Amazon Web Services
 * Modifications: OpenAgentPay (Apache 2.0)
 */
```

---

## 下次 Phase 2 启动时怎么用本文档

1. 读本文档第 4 章（Phase 2 实施清单）
2. 选当前 sprint 要做的项
3. 打开对应 `~/.cache/oap-refs/<repo>/<file>` 查看
4. 创建 PR 时 commit message 注明 "vendor from Repo #N: <file>"

这是把 Neo 给的 4 个 repo 的价值**最大化**的方式——不重写、不污染、有出处。

---

*Last updated: 2026-05-17 21:40 · Author: OpenAgentPay × Kiro*
