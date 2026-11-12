# Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this
repository (Security → Advisories), not in public issues. You will get a reply within a few days.

Cairn stores password hashes (scrypt), session and token hashes (SHA-256), and never logs secrets.
Run it behind HTTPS and set `CAIRN_SECURE_COOKIES=1` when it is only reachable over HTTPS.
