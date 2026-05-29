"""CrewAI tool wrapper.

CrewAI's BaseTool interface (post-v0.30) expects:
  name: str
  description: str
  args_schema: pydantic BaseModel (optional)
  _run(*args, **kwargs) -> str  (sync)
  _arun(*args, **kwargs) -> str (async, optional)

We construct a class with that shape WITHOUT taking a hard dep on crewai —
duck-typing handles the rest. When `crewai` is installed, our class subclasses
their BaseTool transparently.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .client import (
    DEFAULT_BUDGET_USD,
    DEFAULT_EXPIRY_MIN,
    OpenAgentPayClient,
)
from .errors import OpenAgentPayError


# Optional: subclass crewai.BaseTool when installed; fall back to duck-typing.
try:
    from crewai.tools import BaseTool as _CrewBaseTool  # type: ignore[import-not-found]
    _HAS_CREWAI = True
except Exception:  # pragma: no cover — environment-dependent
    _CrewBaseTool = object  # type: ignore[misc, assignment]
    _HAS_CREWAI = False


_TOOL_DESCRIPTION = """\
Make an autonomous payment via OpenAgentPay.

Use when the user explicitly authorizes a payment, or when the agent encounters
HTTP 402 (Payment Required) from a paid API. The 7-Layer Guardrail (session
budget, policy rules, on-chain settlement, sanctions/compliance, identity,
audit) enforces hard limits — denied payments come back with errorCode.

Inputs:
  amount_usd: USD amount; settles in USDC. Must be > 0.
  recipient: 0x… address or merchant id.
  reason: Short audit-log reason.
  wallet_provider: Optional — 'coinbase-cdp', 'hashkey-chain', 'metamask', 'solana'.
  mandates: Optional list of AP2 W3C VC mandate dicts (Intent → Cart → Payment).

Returns: JSON string. Success: {"success": true, "txHash": "0x..."}.
"""


class OpenAgentPayCrewTool(_CrewBaseTool):  # type: ignore[misc]
    """CrewAI-compatible payment tool.

    Falls back to a plain object when crewai is not installed — still callable
    via _run / _arun.
    """

    name: str = "openagentpay_pay"
    description: str = _TOOL_DESCRIPTION

    def __init__(
        self,
        *,
        api_url: str,
        default_wallet_provider: str | None = None,
        default_session_budget_usd: float = DEFAULT_BUDGET_USD,
        default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
        **kwargs: Any,
    ) -> None:
        # When crewai BaseTool is real (pydantic model), pass kwargs through;
        # otherwise just init plain object.
        if _HAS_CREWAI:
            super().__init__(**kwargs)  # type: ignore[misc]
        self._client = OpenAgentPayClient(
            api_url=api_url,
            default_wallet_provider=default_wallet_provider,
            default_session_budget_usd=default_session_budget_usd,
            default_session_expiry_minutes=default_session_expiry_minutes,
        )

    async def _arun(
        self,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
        mandates: list[dict] | None = None,
    ) -> str:
        try:
            r = await self._client.pay(
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

    def _run(
        self,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
        mandates: list[dict] | None = None,
    ) -> str:
        """Sync wrapper for CrewAI's BaseTool._run contract."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # CrewAI calls _run synchronously even when the event loop
                # is active — schedule a task and wait for it via run_until_complete
                # in a thread. Here we use a simple approach: create a new loop.
                import threading
                result_holder: list[str] = []

                def runner() -> None:
                    new_loop = asyncio.new_event_loop()
                    try:
                        result_holder.append(
                            new_loop.run_until_complete(
                                self._arun(
                                    amount_usd, recipient, reason, wallet_provider, mandates
                                )
                            )
                        )
                    finally:
                        new_loop.close()

                t = threading.Thread(target=runner)
                t.start()
                t.join()
                return result_holder[0] if result_holder else json.dumps(
                    {"success": False, "errorCode": "internal", "errorMessage": "no result"}
                )
            return loop.run_until_complete(
                self._arun(amount_usd, recipient, reason, wallet_provider, mandates)
            )
        except RuntimeError:
            return asyncio.run(
                self._arun(amount_usd, recipient, reason, wallet_provider, mandates)
            )


def create_payment_tool(
    *,
    api_url: str,
    default_wallet_provider: str | None = None,
    default_session_budget_usd: float = DEFAULT_BUDGET_USD,
    default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
) -> OpenAgentPayCrewTool:
    """Build a CrewAI-compatible payment tool."""
    return OpenAgentPayCrewTool(
        api_url=api_url,
        default_wallet_provider=default_wallet_provider,
        default_session_budget_usd=default_session_budget_usd,
        default_session_expiry_minutes=default_session_expiry_minutes,
    )


def has_crewai_sdk() -> bool:
    return _HAS_CREWAI
