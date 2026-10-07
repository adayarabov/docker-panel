# Security policy

docker-panel runs `docker` and `docker compose` commands on your machine as the
user Claude Code runs as, in the session's working directory. It never sends data
anywhere; the only text that leaves your machine is what you choose to submit
after pressing **Ask Claude**, which puts service logs into your prompt.

Please report a vulnerability privately through
[GitHub security advisories](https://github.com/adayarabov/docker-panel/security/advisories/new)
rather than a public issue.
