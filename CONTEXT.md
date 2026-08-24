# BLACKBOX

BLACKBOX is an AI-agent security incident investigation product built for the TrueForge hackathon.

## Language

**BLACKBOX**:
The product that investigates a compromised AI-agent session, prepares a remediation, and verifies the result by replaying the attack.
_Avoid_: security platform, generic scanner, SOC replacement

**Victim Agent**:
The AI agent whose behavior is investigated after a suspected compromise.
_Avoid_: target agent, monitored agent

**Support Agent**:
The canonical Victim Agent, which handles customer Support Tickets and can use business tools on the customer's behalf.
_Avoid_: chatbot, customer-service bot

**Support Ticket**:
Untrusted customer-provided content processed by the Support Agent and used as the delivery vehicle for the canonical Incident.
_Avoid_: prompt, user message

**Incident**:
One bounded sequence in which untrusted input causes a Victim Agent to attempt unsafe tool use.
_Avoid_: alert, vulnerability

**Attack Replay**:
A controlled repetition of the Incident using synthetic data and a canary secret to determine whether exploitation succeeds.
_Avoid_: simulation, penetration test

**Canary Secret**:
A synthetic, uniquely identifiable value whose arrival at the External Sink proves that the Incident exposed protected information.
_Avoid_: credential, production secret

**External Sink**:
A controlled destination that records outbound actions from the Support Agent during an Attack Replay.
_Avoid_: attacker server, exfiltration server

**Remediation**:
A proposed change intended to prevent the Incident from succeeding again, applied only after human approval.
_Avoid_: automatic fix, recommendation
