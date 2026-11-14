"""Single-dispatch request envelope; pure state logic, never calls a transport."""
from dataclasses import dataclass
from enum import Enum
import hashlib

class State(str, Enum):
    CREATED="CREATED"
    PENDING="PENDING"
    APPROVED="APPROVED"
    DENIED="DENIED"
    EXPIRED="EXPIRED"
    REVOKED="REVOKED"
    DISPATCH_UNKNOWN="DISPATCH_UNKNOWN"
    SENT="SENT"
    REPLIED="REPLIED"

@dataclass(frozen=True)
class Identity:
    provider: str
    profile: str
    tab_id: int
    origin: str
    conversation_id: str

    def __post_init__(self):
        if not all(isinstance(s,str) and s.strip() for s in (self.provider,self.profile,self.origin,self.conversation_id)):
            raise ValueError("Missing identity")
        if type(self.tab_id) is not int or self.tab_id <= 0:
            raise ValueError("Invalid tab")
        if not self.origin.startswith("https://") or "/" in self.origin[8:]:
            raise ValueError("Invalid origin")

class Envelope:
    def __init__(self, request_id, identity, payload, expires_at):
        if not isinstance(request_id,str) or not request_id.strip() or not isinstance(payload,str) or not payload:
            raise ValueError("Missing request/payload")
        if type(expires_at) is not int: raise ValueError("Invalid expiry")
        self.request_id=request_id
        self.identity=identity
        self.payload_hash=hashlib.sha256(payload.encode("utf8")).hexdigest()
        self.expires_at=expires_at
        self.state=State.CREATED
        self.dispatch_claimed=False
        self.reply_hash=None

    def _require(self, expected):
        if self.state != expected: raise ValueError("Invalid state: "+self.state.value)

    def _expiry(self, now):
        if type(now) is not int: raise ValueError("Invalid time")
        if now >= self.expires_at:
            if self.state in (State.CREATED,State.PENDING,State.APPROVED):
                self.state=State.EXPIRED
            raise ValueError("Expired")

    def request_approval(self, now):
        self._expiry(now); self._require(State.CREATED); self.state=State.PENDING

    def approve(self, now):
        self._expiry(now); self._require(State.PENDING); self.state=State.APPROVED

    def deny(self):
        self._require(State.PENDING); self.state=State.DENIED

    def claim(self, now, identity, payload):
        """Persist returned snapshot BEFORE attempting transport; UNKNOWN must not be retried."""
        self._expiry(now); self._require(State.APPROVED)
        if self.dispatch_claimed or identity != self.identity: raise ValueError("Binding/claim mismatch")
        if hashlib.sha256(payload.encode("utf8")).hexdigest() != self.payload_hash:
            raise ValueError("Payload mismatch")
        self.dispatch_claimed=True
        self.state=State.DISPATCH_UNKNOWN
        return self.request_id

    def confirm_sent(self, request_id, identity):
        self._require(State.DISPATCH_UNKNOWN)
        self._correlate(request_id,identity)
        self.state=State.SENT

    def reply(self, request_id, identity, content):
        self._require(State.SENT)
        self._correlate(request_id,identity)
        if not isinstance(content,str) or not content.strip(): raise ValueError("Empty reply")
        self.reply_hash=hashlib.sha256(content.encode("utf8")).hexdigest()
        self.state=State.REPLIED

    def _correlate(self, request_id, identity):
        if request_id != self.request_id or identity != self.identity:
            raise ValueError("Correlation mismatch")

    def revoke(self):
        if self.state not in (State.DENIED,State.EXPIRED,State.REVOKED,State.REPLIED):
            self.state=State.REVOKED

    def snapshot(self):
        return dict(request_id=self.request_id,identity=self.identity.__dict__.copy(),
                    payload_hash=self.payload_hash,expires_at=self.expires_at,
                    state=self.state.value,dispatch_claimed=self.dispatch_claimed,
                    reply_hash=self.reply_hash)

    @classmethod
    def recover(cls, saved):
        i=Identity(**saved["identity"])
        x=cls.__new__(cls)
        x.request_id=saved["request_id"]
        x.identity=i
        x.payload_hash=saved["payload_hash"]
        x.expires_at=saved["expires_at"]
        x.state=State(saved["state"])
        x.dispatch_claimed=saved["dispatch_claimed"]
        x.reply_hash=saved["reply_hash"]
        if x.state in (State.DISPATCH_UNKNOWN,State.SENT,State.REPLIED) and not x.dispatch_claimed:
            raise ValueError("Inconsistent dispatch journal")
        if x.dispatch_claimed and x.state in (State.CREATED,State.PENDING,State.APPROVED):
            raise ValueError("Inconsistent approval journal")
        return x
