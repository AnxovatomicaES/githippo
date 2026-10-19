# Security policy

githippo stores people's memory and, in remote mode, serves it over the network, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Use GitHub's **Report a vulnerability** button on the repository's *Security* tab (private vulnerability reporting).
2. If that button isn't there, open a public issue that says only "I have a security report, please open a private channel", with no details, and the maintainer will respond with one.

Include what you found, how to reproduce it (a script or a test is ideal), and the version (`githippo --version`). You will get an acknowledgement, and a fix or a clear answer, as quickly as one maintainer can manage; there is no bounty.

## What is in scope

- Anything that lets one user read or write another user's notes, or notes outside their folder grants, in a team vault.
- Authentication or OAuth bypass, token forgery or replay, and anything that crashes or exhausts the remote server from an unauthenticated client.
- Secrets or personal data reaching memory or git history despite the compliance guard, or being sent anywhere they should not go (the backup repository included).
- The installer and `githippo setup` / `uninstall` damaging a user's Claude Code configuration or running unexpected code.
- Prompt injection that gets text saved and replayed as trusted (core) memory.

## What is not

- The guard is a backstop for common formats, not a data-loss-prevention product; a secret in an unusual format getting through is a bug report, not a vulnerability.
- Memory you deliberately write to a public repository, or to a backup remote you made public (githippo refuses to push to a public GitHub remote unless you set `GITHIPPO_ALLOW_PUBLIC_BACKUP=1`).
- Anything that needs control of the machine githippo runs on, or of its `~/.githippo` folder.

## Supported versions

Only the latest release gets fixes.
