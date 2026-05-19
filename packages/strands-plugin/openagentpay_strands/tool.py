"""
Strands tool factory — turns OpenAgentPayClient into a function compatible with
both Strands @tool decorator and any Python callable-based agent framework.

Strands SDK is an OPTIONAL dependency at import time:
  - If `strands` package is installed, we wrap with @tool and you get full
    Strands integration (Agent.tools=[...]).
  - If `strands` is NOT installed, we still return a plain async function that
    returns a JSON string — usable with any custom agent framework.
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError

# Strands SDK is optional. If absent, we still produce a usable async function.
try:
    from strands import tool as _strands_tool  # type: ignore[import-not-found]
    _HAS_STRANDS = True
except ImportError:  # pragma: no cover — environment-dependent
    _strands_tool = None
    _HAS_STRANDS = False


_TOOL_DOC = """\
Make an autonomous payment via OpenAgentPay.

Use this when the user explicitly authorizes a payment, or when you encounter
an HTTP 402 (Payment Required) response from an API. The payment is enforced
by a 7-layer Guardrail (session budget, policy rules, on-chain immutability,
sanctions/compliance, identity, audit) — you cannot bypass these checks.

Args:
    amount_usd: amount to pay in USD (settles in USDC). Must be positive.
    recipient: chain address (0x...) or merchant id
    reason: short human-readable reason (logged to audit trail)
    wallet_provider: optional wallet override (e.g. "coinbase-cdp", "hashkey-chain").
        If omitted, uses the agent's configured default.

Returns:
    JSON string. Success: {"success": true, "txHash": "0x...", "explorerUrl": "..."}
    Failure: {"success": false, "errorCode": "policy_denied" | ..., "errorMessage": "..."}
"""


def create_payment_tool(
    *,
    api_url: str,
    default_wallet_provider: str | None = None,
    default_session_budget_usd: float = DEFAULT_BUDGET_USD,
    default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
    name: str = "openagentpay_pay",
) -> Callable[..., Awaitable[str]]:
    """Build a Strands-compatible payment tool.

    Args:
        api_url: base URL of the OpenAgentPay demo-api deployment.
            E.g., "https://d1p7yxa99nxaye.cloudfront.net" or "http://localhost:8787".
        default_wallet_provider: wallet to use when caller omits walletProvider.
            E.g., "coinbase-cdp" or "hashkey-chain".
        default_session_budget_usd: hard budget cap per auto-created session.
        default_session_expiry_minutes: session TTL.
        name: tool name surfaced to the LLM. Defaults to "openagentpay_pay".

    Returns:
        Async callable. When Strands SDK is installed, the callable is also
        decorated with @tool so you can pass it directly to ``Agent(tools=[...])``.
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
    ) -> str:
        """Inner — see _TOOL_DOC for full documentation (set below)."""
        try:
            r = await client.pay(
                amount_usd=amount_usd,
                recipient=recipient,
                reason=reason,
                wallet_provider=wallet_provider,
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

    if _HAS_STRANDS and _strands_tool is not None:
        # Decorate with @tool to register with Strands' tool registry.
        decorated: Any = _strands_tool(openagentpay_pay)
        return decorated  # type: ignore[no-any-return]

    return openagentpay_pay


def has_strands_sdk() -> bool:
    """Return True if the optional `strands` SDK is installed."""
    return _HAS_STRANDS
