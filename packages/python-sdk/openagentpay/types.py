"""
OpenAgentPay Python SDK — canonical types.

Mirrors @openagentpay/core/types.ts exactly. Keep these two files in sync —
breaking changes must update both languages and bump the alpha version.

Design notes
------------
- We use frozen dataclasses for value objects (Money, Asset, Session, ...).
- WalletConnector / ProtocolAdapter are typing.Protocol so any class with the
  right methods qualifies — no inheritance required. This matches the TS
  interface freedom.
- Money.amount_atomic is a str (not int) so JSON round-trips preserve precision
  for amounts > 2^53 (e.g., huge BTC sat counts).

License: Apache-2.0
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Protocol, runtime_checkable

# ==============================================================================
#  Branded identifier aliases
# ==============================================================================
# Python doesn't enforce Brand<T> at runtime, but we declare these as NewType so
# mypy/pyright catch mix-ups (UserId vs SessionId, etc.).
from typing import NewType

UserId = NewType("UserId", str)
SessionId = NewType("SessionId", str)
InstrumentId = NewType("InstrumentId", str)
WalletProviderId = NewType("WalletProviderId", str)
ProtocolId = NewType("ProtocolId", str)
TransactionRef = NewType("TransactionRef", str)


# ==============================================================================
#  Money / Asset
# ==============================================================================

@dataclass(frozen=True, slots=True)
class Money:
    """Atomic-unit money. Never use float for payment amounts."""

    amount_atomic: str  # stringified integer (matches TS amountAtomic)
    decimals: int
    currency: str  # USD, USDC, USDT, ...

    def to_decimal(self) -> float:
        """Convenience: lossy float view for display only. Don't use for math."""
        return int(self.amount_atomic) / (10**self.decimals)


@dataclass(frozen=True, slots=True)
class Asset:
    symbol: str
    decimals: int
    chain: str | None = None  # CAIP-2 like "eip155:84532"
    contract: str | None = None


# ==============================================================================
#  Session
# ==============================================================================

SessionStatus = Literal["active", "exhausted", "expired", "closed"]


@dataclass(frozen=True, slots=True)
class Session:
    id: SessionId
    user_id: UserId
    budget: Money
    spent: Money
    expires_at: str  # ISO 8601
    created_at: str
    updated_at: str
    status: SessionStatus
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CreateSessionInput:
    user_id: UserId
    budget_usd: float
    expires_minutes: int
    metadata: Mapping[str, str] = field(default_factory=dict)


ReservationReason = Literal[
    "budget_exceeded",
    "session_expired",
    "session_closed",
    "policy_denied",
]


@dataclass(frozen=True, slots=True)
class ReservationResult:
    approved: bool
    remaining_budget: Money
    reason: ReservationReason | None = None


# ==============================================================================
#  Instrument
# ==============================================================================

@dataclass(frozen=True, slots=True)
class Instrument:
    id: InstrumentId
    user_id: UserId
    wallet_provider: WalletProviderId
    public_handle: str  # on-chain address OR provider account ID
    created_at: str
    provider_metadata: Mapping[str, Any] = field(default_factory=dict)


# ==============================================================================
#  Wallet capability self-report
# ==============================================================================

@dataclass(frozen=True, slots=True)
class WalletCapabilities:
    wallet_provider: WalletProviderId
    display_name: str
    supported_assets: tuple[Asset, ...]
    supported_protocols: tuple[ProtocolId, ...]
    requires_user_approval: bool
    settles_on_chain: bool
    typical_latency_ms: int | None = None
    features: Mapping[str, bool | str | int] = field(default_factory=dict)


# ==============================================================================
#  Payment Request / Authorization / Settlement
# ==============================================================================

@dataclass(frozen=True, slots=True)
class PaymentRequest:
    protocol: ProtocolId
    amount: Money
    recipient: str
    asset: Asset
    valid_after: int  # unix seconds
    valid_before: int
    nonce: str  # hex
    raw_payload: Any  # original 402 body, kept verbatim
    description: str | None = None


@dataclass(frozen=True, slots=True)
class SignedAuthorization:
    request: PaymentRequest
    signer: str
    signature: str  # opaque, protocol-specific encoding
    encoded: str | None = None  # ready-for-wire form (e.g., base64 X-PAYMENT)
    extra: Mapping[str, Any] = field(default_factory=dict)


SettlementErrorCode = Literal[
    "insufficient_funds",
    "signature_invalid",
    "nonce_used",
    "expired_authorization",
    "rpc_error",
    "rate_limited",
    "compliance_blocked",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class SettlementResult:
    success: bool
    network: str
    settled_at: str  # ISO 8601
    transaction_ref: TransactionRef | None = None
    settled_amount: Money | None = None
    error_code: SettlementErrorCode | None = None
    error_message: str | None = None
    raw: Any = None


# ==============================================================================
#  HTTP envelope helpers (used by ProtocolAdapter)
# ==============================================================================

@dataclass(frozen=True, slots=True)
class HttpResponse402:
    status_code: Literal[402]
    headers: Mapping[str, str]
    body: Any


@dataclass(frozen=True, slots=True)
class HttpRetryEnvelope:
    headers: Mapping[str, str]
    body: Any | None = None


class ProtocolError(Exception):
    """Raised when a 402 response cannot be parsed by the chosen adapter."""

    def __init__(
        self,
        message: str,
        code: Literal[
            "malformed",
            "unsupported_version",
            "unsupported_scheme",
            "missing_field",
            "internal",
        ],
    ) -> None:
        super().__init__(message)
        self.code = code


# ==============================================================================
#  Spend Governor
# ==============================================================================

SpendDeniedReason = Literal[
    "budget_exceeded",
    "team_limit_exceeded",
    "asset_not_allowed",
    "recipient_blocked",
    "kyt_flagged",
    "approval_required",
    "policy_denied",
]


@dataclass(frozen=True, slots=True)
class SpendEvaluationInput:
    session: Session
    request: PaymentRequest
    instrument: Instrument


@dataclass(frozen=True, slots=True)
class SpendEvaluationResult:
    allow: bool
    reason: SpendDeniedReason | None = None
    human_message: str | None = None


# ==============================================================================
#  WalletConnector / ProtocolAdapter / SpendGovernor protocols
# ==============================================================================

@dataclass(frozen=True, slots=True)
class CreateInstrumentInput:
    user_id: UserId
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Balance:
    instrument_id: InstrumentId
    asset: Asset
    money: Money
    fetched_at: str


@dataclass(frozen=True, slots=True)
class SignAuthorizationInput:
    instrument_id: InstrumentId
    request: PaymentRequest
    session: Session


@runtime_checkable
class WalletConnector(Protocol):
    """Implement this Protocol to add a new wallet provider."""

    def get_capabilities(self) -> WalletCapabilities: ...

    async def create_instrument(self, input: CreateInstrumentInput) -> Instrument: ...

    async def get_balance(self, instrument_id: InstrumentId) -> Balance: ...

    async def sign_authorization(
        self, input: SignAuthorizationInput
    ) -> SignedAuthorization: ...

    async def settle(self, signed: SignedAuthorization) -> SettlementResult: ...


@runtime_checkable
class ProtocolAdapter(Protocol):
    """Implement this Protocol to add a new payment protocol."""

    id: ProtocolId

    def detect(self, response: HttpResponse402) -> bool: ...

    async def parse_payment_required(
        self, response: HttpResponse402
    ) -> PaymentRequest: ...

    async def build_retry(
        self, signed: SignedAuthorization
    ) -> HttpRetryEnvelope: ...

    # Optional: pre-submit step (most adapters do not need this)
    async def pre_submit(
        self, signed: SignedAuthorization
    ) -> SettlementResult | None: ...


@runtime_checkable
class SpendGovernor(Protocol):
    async def evaluate(
        self, input: SpendEvaluationInput
    ) -> SpendEvaluationResult: ...


# ==============================================================================
#  Runtime config (handed to the orchestrator on each Strands invocation)
# ==============================================================================

@dataclass(frozen=True, slots=True)
class OpenAgentPayRuntimeConfig:
    wallet_provider: WalletProviderId
    protocol: ProtocolId
    instrument_id: InstrumentId
    session_id: SessionId
    user_id: UserId
    payment_manager_endpoint: str  # Lambda Function URL


# ==============================================================================
#  Observability event
# ==============================================================================

PaymentEventType = Literal[
    "session.created",
    "instrument.created",
    "402.detected",
    "request.parsed",
    "budget.checked",
    "credentials.loaded",
    "authorization.signed",
    "settlement.submitted",
    "settlement.completed",
    "settlement.failed",
    "session.committed",
    "audit.emitted",
]


@dataclass(frozen=True, slots=True)
class PaymentEvent:
    type: PaymentEventType
    timestamp: str
    session_id: SessionId | None = None
    user_id: UserId | None = None
    instrument_id: InstrumentId | None = None
    wallet_provider: WalletProviderId | None = None
    protocol: ProtocolId | None = None
    transaction_ref: TransactionRef | None = None
    elapsed_ms: int | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)


# ==============================================================================
#  Helpers
# ==============================================================================

def now_iso() -> str:
    """Current UTC time in ISO 8601 — matches TS Date.toISOString()."""
    return datetime.now(tz=timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


__all__ = [
    "Asset",
    "Balance",
    "CreateInstrumentInput",
    "CreateSessionInput",
    "HttpResponse402",
    "HttpRetryEnvelope",
    "Instrument",
    "InstrumentId",
    "Money",
    "OpenAgentPayRuntimeConfig",
    "PaymentEvent",
    "PaymentEventType",
    "PaymentRequest",
    "ProtocolAdapter",
    "ProtocolError",
    "ProtocolId",
    "ReservationReason",
    "ReservationResult",
    "Session",
    "SessionId",
    "SessionStatus",
    "SettlementErrorCode",
    "SettlementResult",
    "SignAuthorizationInput",
    "SignedAuthorization",
    "SpendDeniedReason",
    "SpendEvaluationInput",
    "SpendEvaluationResult",
    "SpendGovernor",
    "TransactionRef",
    "UserId",
    "WalletCapabilities",
    "WalletConnector",
    "WalletProviderId",
    "now_iso",
]
