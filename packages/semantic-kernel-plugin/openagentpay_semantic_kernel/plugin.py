"""Semantic Kernel plugin class.

SK 1.x:
  from semantic_kernel.functions import kernel_function
  class MyPlugin:
    @kernel_function(name="...", description="...")
    async def some_function(...): ...

We make `@kernel_function` an OPTIONAL import — falling back to a no-op
identity decorator when SK isn't installed (so the plugin remains testable
in pure-Python environments).
"""
from __future__ import annotations

import json

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError


# Optional Semantic Kernel decorator
try:
    from semantic_kernel.functions import kernel_function as _sk_kernel_function  # type: ignore[import-not-found]
    _HAS_SK = True
except Exception:  # pragma: no cover — env-dependent
    _HAS_SK = False

    def _sk_kernel_function(*_args, **_kwargs):  # type: ignore[no-redef]
        def deco(fn):
            return fn
        return deco


class OpenAgentPayPlugin:
    """Semantic Kernel plugin that exposes payment + session-introspection functions."""

    def __init__(
        self,
        *,
        api_url: str,
        default_wallet_provider: str | None = None,
        default_session_budget_usd: float = DEFAULT_BUDGET_USD,
        default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
    ) -> None:
        self._client = OpenAgentPayClient(
            api_url=api_url,
            default_wallet_provider=default_wallet_provider,
            default_session_budget_usd=default_session_budget_usd,
            default_session_expiry_minutes=default_session_expiry_minutes,
        )

    @_sk_kernel_function(
        name="pay",
        description="Make an autonomous payment via OpenAgentPay. Use when the "
                    "user authorizes a payment or when an HTTP 402 (Payment "
                    "Required) is encountered. The 7-Layer Guardrail enforces "
                    "session budget, policy rules, on-chain immutability, "
                    "sanctions/compliance, identity, and audit. Returns a "
                    "JSON string with success / txHash or errorCode.",
    )
    async def pay(
        self,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
    ) -> str:
        """Execute a payment.

        Args:
            amount_usd: USD amount (settles in USDC). Must be > 0.
            recipient: 0x… address or merchant id.
            reason: Audit-log reason.
            wallet_provider: Optional wallet override.
        """
        try:
            r = await self._client.pay(
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

    @_sk_kernel_function(
        name="check_session_budget",
        description="Return the remaining budget for the current payment "
                    "session as a JSON string with sessionId, status, "
                    "remainingUsd, and expiresAt fields.",
    )
    async def check_session_budget(self) -> str:
        """Snapshot the active session's remaining budget."""
        snapshot = await self._client.get_session()
        if snapshot is None:
            return json.dumps({"sessionId": None, "remainingUsd": None})
        try:
            decimals = int(snapshot.get("decimals", 6))
            budget = int(snapshot.get("budgetAtomic", "0"))
            spent = int(snapshot.get("spentAtomic", "0"))
            remaining_atomic = max(0, budget - spent)
            remaining_usd = remaining_atomic / (10 ** decimals)
            return json.dumps(
                {
                    "sessionId": snapshot.get("sessionId"),
                    "status": snapshot.get("status"),
                    "remainingUsd": remaining_usd,
                    "expiresAt": snapshot.get("expiresAt"),
                }
            )
        except (TypeError, ValueError, KeyError) as e:
            return json.dumps({"error": str(e)})


def has_sk_sdk() -> bool:
    return _HAS_SK
