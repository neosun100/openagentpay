"""Async HTTP client mirroring openagentpay-strands.client."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import httpx

from .errors import OpenAgentPayError


DEFAULT_TIMEOUT_S = 30.0
DEFAULT_BUDGET_USD = 5.0
DEFAULT_EXPIRY_MIN = 30


@dataclass(slots=True)
class _SessionState:
    session_id: Optional[str] = None
    expires_at_epoch: float = 0.0


class OpenAgentPayClient:
    """Async HTTP client for the OpenAgentPay proxy / demo API."""

    def __init__(
        self,
        api_url: str,
        user_id: str,
        *,
        api_key: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        default_budget_usd: float = DEFAULT_BUDGET_USD,
        default_expiry_min: int = DEFAULT_EXPIRY_MIN,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.user_id = user_id
        self.api_key = api_key
        self.timeout_s = timeout_s
        self.default_budget_usd = default_budget_usd
        self.default_expiry_min = default_expiry_min
        self._session = _SessionState()
        self.session_creates = 0  # for tests

    # ------------------------------------------------------------------ pay
    async def pay(
        self,
        *,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
    ) -> dict[str, Any]:
        sess_id = await self._ensure_session()
        try:
            return await self._do_pay(
                session_id=sess_id,
                amount_usd=amount_usd,
                recipient=recipient,
                reason=reason,
                wallet_provider=wallet_provider,
            )
        except OpenAgentPayError as err:
            # On 404 (session expired across instances), one-shot retry.
            if err.http_status == 404:
                self._session = _SessionState()
                sess_id = await self._ensure_session()
                return await self._do_pay(
                    session_id=sess_id,
                    amount_usd=amount_usd,
                    recipient=recipient,
                    reason=reason,
                    wallet_provider=wallet_provider,
                )
            raise

    # --------------------------------------------------------------- internals

    async def _ensure_session(self) -> str:
        if self._session.session_id:
            return self._session.session_id
        body = {
            "userId": self.user_id,
            "budgetUsd": self.default_budget_usd,
            "expiresMinutes": self.default_expiry_min,
        }
        async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
            r = await cli.post(
                f"{self.api_url}/api/session", json=body, headers=self._headers()
            )
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"create session failed: HTTP {r.status_code}",
                code="session_create_failed",
                http_status=r.status_code,
            )
        data = r.json()
        self._session.session_id = data.get("id")
        self.session_creates += 1
        return self._session.session_id  # type: ignore[return-value]

    async def _do_pay(
        self,
        *,
        session_id: str,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "sessionId": session_id,
            "amountUsd": amount_usd,
            "recipient": recipient,
            "reason": reason,
        }
        if wallet_provider:
            body["walletProvider"] = wallet_provider
        async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
            r = await cli.post(
                f"{self.api_url}/api/pay", json=body, headers=self._headers()
            )
        if r.status_code >= 500:
            raise OpenAgentPayError(
                f"pay failed: HTTP {r.status_code}",
                code="upstream_error",
                http_status=r.status_code,
            )
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"pay rejected: HTTP {r.status_code}",
                code="rejected",
                http_status=r.status_code,
            )
        return r.json()

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h
