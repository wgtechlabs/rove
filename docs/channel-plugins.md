# Installable channel protocol

Rove can install a released **Channel Plugin** containing a declarative signed
JSON adapter. Core owns signature verification, access checks, conversation
isolation, approvals and delivery. No package JavaScript runs. This is a protocol
for a separately operated integration, not a claim that Telegram, Discord or a
separately released Slack plugin is supported. Bundled Slack remains unchanged.

Use the normal approved-repository installation and version lifecycle. A native
package with `category: "channel"` declares:

```json
{
  "channel": {
    "type": "hmac-json",
    "signing": {
      "secret": "signing-key",
      "timestampHeader": "x-event-timestamp",
      "signatureHeader": "x-event-signature"
    },
    "incoming": {
      "eventId": "/event/id",
      "tenant": "/workspace",
      "actor": "/user",
      "destination": "/room",
      "thread": "/thread",
      "text": "/text",
      "approvalId": "/approval/id",
      "decision": "/approval/decision"
    },
    "outgoing": {
      "url": "https://integration.example.com/reply",
      "secret": "delivery-token",
      "fields": { "destination": "room", "thread": "thread", "text": "text" }
    }
  },
  "secrets": [
    { "key": "signing-key", "label": "Signing key", "required": true },
    { "key": "delivery-token", "label": "Delivery token", "required": true }
  ],
  "capabilities": ["channel:ingress", "channel:delivery"]
}
```

This fragment supplements the normal API v1 identity/version fields. Replace the
example endpoint. Both secrets must be declared as required; both permissions
need explicit grants. Incoming paths are bounded JSON pointers into objects.
Approval bindings must be supplied together or omitted together.

In **Plugins**, enter the permitted workspace ID, user IDs, conversation
destinations and users who may approve actions. Approval users must also be
allowed users. These rules are dashboard configuration, never package content.
Save and activate separately. The dashboard shows the webhook path and delivery
status counts; failed channel initialization leaves web setup and chat available.

## Receive events

POST the raw UTF-8 JSON body to `/api/channels/<installation-id>/events` with
`Content-Type: application/json`. The timestamp header contains Unix seconds.
The signature header is `v1=` followed by the lowercase hexadecimal HMAC-SHA256
of `v1:<timestamp>:<raw-body>`, using the signing key. Timestamps must be within
five minutes of the server clock. Envelopes are limited to 64 KiB and message text
to 4,000 characters.

The integration holding the signing key must authenticate its provider and derive
identities from verified events. Signing caller-chosen identities would give the
caller that identity's access. Rove checks the signed workspace, user and
destination against administrator rules; it does not authenticate a third-party
provider's users itself.

A new event returns `202` after durable storage. A repeated event ID for the same
installation returns `200` without repeating execution or delivery. Keep provider
event IDs stable across retries. Other installations and web/Slack conversations
have separate identities and history. Events in a permitted workspace,
destination and thread share a conversation.

Approvals reference the exact pending approval ID and use `approve`, `deny` or
`resume`. Only configured approval users may send them, in the original thread.
`resume` continues the model reply after a saved tool outcome; it never runs the
tool again. Oversized approval details cannot be approved through this protocol.

## Delivery and failure behavior

Core posts the configured destination, thread and reply fields to the fixed
public HTTPS endpoint using the delivery token as a bearer credential. DNS is
validated and pinned per request; private destinations and redirects are rejected.
The event body cannot select another URL, credential or conversation scope.

Repository revocation, configuration changes, deactivation and bound-secret
rotation invalidate queued work before dispatch or delivery. An already dispatched
external request cannot be undone. Known pre-dispatch chat contention stays queued;
other uncertain execution or delivery outcomes are never retried automatically.
When a tool finishes but its model continuation fails, Rove delivers the saved
approval ID so an administrator can request `resume`.

An interrupted `processing` or `delivering` job becomes `uncertain` at restart.
Pending and prepared replies survive restart, subject to current permissions.
Event tombstones are retained: 10,000 total events and 500 outstanding jobs per
deployment. Reaching either bound rejects new events; no automatic archival is
implemented. Use one process and replica per database. Do not treat a controlled
local integration test as proof of delivery to a live provider.
