"""AutoGen tool factory.

AutoGen >= v0.4 expects async callables with type hints; type hints become the
tool schema. AutoGen <= v0.2 (legacy) uses dict-style tool descriptors.

We expose a plain async function that works with both — AutoGen v0.4 will
infer the schema from type hints, and v0.2 users can wrap with
register_function() manually.
"""
from __future__ import annotations

import json
from typing import Awaitable, Callable

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError


_TOOL_DOC = """\
Make an autonomous payment via OpenAgentPay.

Use when the user authorizes a payment, or when the agent encounters
HTTP 402 (Payment Required). The 7-Layer Guardrail (session budget,
policy rules, on-chain settlement, sanctions/compliance, identity, audit)
enforces hard limits — denied payments come back with errorCode.

Args:
    amount_usd: USD amount; settles in USDC. Must be > 0.
    recipient: 0x… address or merchant id.
    reason: Short human-readable reason (logged to audit trail).
    wallet_provider: Optional override (e.g., 'coinbase-cdp', 'metamask',
        'solana'). Falls back to default.
    mandates: Optional AP2 W3C VC mandate chain (Intent → Cart → Payment).

Returns:
    JSON string. Success: {"success": true, "txHash": "0x...", ...}.
    Failure: {"success": false, "errorCode": "policy_denied" | ...}.
"""


def create_payment_tool(
    *,
    api_url: str,
    default_wallet_provider: str | None = None,
    default_session_budget_usd: float = DEFAULT_BUDGET_USD,
    default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
    name: str = "openagentpay_pay",
) -> Callable[..., Awaitable[str]]:
    """Build an async AutoGen-compatible payment tool.

    AutoGen >= v0.4: pass directly to AssistantAgent(tools=[pay_tool])
    AutoGen <= v0.2: register via register_function(pay_tool, ...)
    """
    client = OpenAgentPayClient(
        api_url=api_url,
        default_wallet_provider=default_wallet_provider,
        default_session_budget_usd=default_session_budget_usd,
        default_session_expiry_minutes=default_session_expiry_minutes,
    )

    async def openagentpay_pay(
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
        mandates: list[dict] | None = None,
    ) -> str:
        try:
            r = await client.pay(
                amount_usd=amount_usd,
                recipient=recipient,
                reason=reason,
                wallet_provider=wallet_provider,
                mandates=mandates,
            )
            return json.dumps(r.to_dict())
        except OpenAgentPayError as e:
            return json.dumps(
                {
                    "success": False,
                    "errorCode": e.code,
                    "errorMessage": e.message,
                    **(
                        {"httpStatus": e.http_status}
                        if e.http_status is not None
                        else {}
                    ),
                }
            )
        except (ValueError, TypeError) as e:
            return json.dumps(
                {
                    "success": False,
                    "errorCode": "validation_error",
                    "errorMessage": str(e),
                }
            )

    openagentpay_pay.__name__ = name
    openagentpay_pay.__doc__ = _TOOL_DOC
    return openagentpay_pay
