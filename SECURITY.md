# Security policy

## Supported releases

Version `0.1.0` is an unsigned development release. It is maintained for local evaluation but is not a signed public security release.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential, trust-boundary bypass, or provider-admission bypass.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/mahmoud20138/Unified-Agent-Dev/security/advisories/new

Include the affected version, Windows and host CLI versions, reproduction steps, expected result, actual result, and the smallest safe proof of concept. Do not include live credentials or private user configuration.

## Security boundary

The public catalogue is untrusted research metadata. Only exact artifacts represented in `catalog/providers.runtime.json` are eligible for execution. A report that demonstrates catalogue-only code can be downloaded, installed, or invoked is considered a security issue.
