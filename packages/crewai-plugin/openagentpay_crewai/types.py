"""Type definitions mirrored from openagentpay-strands."""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PaymentResult:
    success: bool
    wallet_provider: str
    amount_usd: float
    recipient: str
    tx_hash: str | None = None
    explorer_url: str | None = None
    network: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    audit_event_id: str | None = None
    had_mandates: bool = False

    def to_dict(self) -> dict:
        d: dict = {
            "success": self.success,
            "walletProvider": self.wallet_provider,
            "amountUsd": self.amount_usd,
            "recipient": self.recipient,
            "hadMandates": self.had_mandates,
        }
        if self.tx_hash is not None:
            d["txHash"] = self.tx_hash
        if self.explorer_url is not None:
            d["explorerUrl"] = self.explorer_url
        if self.network is not None:
            d["network"] = self.network
        if self.error_code is not None:
            d["errorCode"] = self.error_code
        if self.error_message is not None:
            d["errorMessage"] = self.error_message
        return d
