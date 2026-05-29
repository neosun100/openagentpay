"""PydanticAI Tool factory."""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Optional

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .types import PaymentInput, PaymentResult


_TOOL_DOC = """\
Make a USD-denominated payment via OpenAgentPay (settles in USDC).

Use this when the agent must pay for an external service or merchant. Always
include a non-empty `reason` for audit. The plugin enforces session budget
and merchant policy server-side; payment may be denied even after this call
returns — check the result.
"""


def has_pydantic_ai_sdk() -> bool:
    try:
        import pydantic_ai  # noqa: F401
        return True
    except ImportError:
        return False


def create_payment_tool(
    *,
    api_url: str,
    user_id: str,
    api_key: Optional[str] = None,
    default_wallet_provider: Optional[str] = None,
) -> Callable[[PaymentInput], Awaitable[PaymentResult]]:
    """Build an async callable usable as a PydanticAI Tool.

    If `pydantic_ai` is installed, the returned callable can be passed
    straight into ``Agent(tools=[pay])`` and the SDK will pick up its
    type annotations.

    If not installed, you still get a typed async function for direct use.
    """
    client = OpenAgentPayClient(
        api_url=api_url,
        user_id=user_id,
        api_key=api_key,
    )

    async def pay(input_: PaymentInput) -> PaymentResult:
        """Make a USD-denominated payment via OpenAgentPay."""
        try:
            raw = await client.pay(
                amount_usd=input_.amount_usd,
                recipient=input_.recipient,
                reason=input_.reason,
                wallet_provider=input_.wallet_provider or default_wallet_provider,
            )
        except OpenAgentPayError as err:
            return PaymentResult(
                success=False,
                wallet_provider=input_.wallet_provider or default_wallet_provider or "",
                amount_usd=input_.amount_usd,
                recipient=input_.recipient,
                error_code=err.code,
                error_message=str(err),
            )
        wp = (
            raw.get("walletProvider")
            or input_.wallet_provider
            or default_wallet_provider
            or ""
        )
        return PaymentResult(
            success=bool(raw.get("success", False)),
            tx_hash=raw.get("txHash"),
            explorer_url=raw.get("explorerUrl"),
            wallet_provider=wp,
            amount_usd=input_.amount_usd,
            recipient=input_.recipient,
            error_code=raw.get("errorCode"),
            error_message=raw.get("errorMessage"),
        )

    pay.__doc__ = _TOOL_DOC
    return pay
