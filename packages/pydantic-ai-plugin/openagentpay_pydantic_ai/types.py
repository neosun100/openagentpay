"""Pydantic v2 input/output models."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field, ConfigDict


class PaymentInput(BaseModel):
    """Schema the LLM fills in when calling the payment tool."""

    model_config = ConfigDict(extra="forbid")

    amount_usd: float = Field(
        ..., gt=0, description="Amount in USD. Settles in USDC at 1:1."
    )
    recipient: str = Field(..., min_length=1, description="0x… or merchant ID.")
    reason: str = Field(..., min_length=1, description="Why this payment.")
    wallet_provider: Optional[str] = Field(
        None, description="Optional wallet override (defaults to plugin default)."
    )


class PaymentResult(BaseModel):
    """Returned to the LLM as a tool-call result."""

    model_config = ConfigDict(extra="allow")

    success: bool
    tx_hash: Optional[str] = None
    explorer_url: Optional[str] = None
    wallet_provider: str
    amount_usd: float
    recipient: str
    error_code: Optional[str] = None
    error_message: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)
