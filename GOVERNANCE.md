# Governance

Central City is an open-source project under the [Apache License 2.0](LICENSE). This document
describes, briefly, who maintains it and how decisions are made. It will evolve as the
contributor community grows.

## Roles

- **Contributors** — anyone who opens an issue, discussion or pull request, including
  AI-assisted contributions under the rules in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainers** — members of the `centralcity-ai` GitHub organization with write access to
  this repository. Maintainers review and merge pull requests, triage issues, cut releases,
  handle security reports and enforce the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Lead maintainer** — the Central City project lead, who sets product direction and
  resolves decisions that do not reach consensus.

The current maintainers are listed in the repository's `CODEOWNERS`/organization team once
published; until then, maintainers act through the `centralcity-ai` organization account.
New maintainers are invited by existing maintainers after a sustained record of high-quality
contributions and reviews.

## Decision process

- **Everyday changes** are decided in pull requests: a change merges when a maintainer
  approves it and required CI checks pass (`main` is branch-protected).
- **Significant changes** — new public protocols or endpoints, authentication and
  authorization model changes, data-format or migration changes, new runtime dependencies
  with broad impact, licence questions — start as an issue labelled `proposal`. Maintainers
  seek lazy consensus for at least 7 days; if consensus is not reached, the lead maintainer
  decides and records the reasoning in the issue.
- **Security fixes** are handled privately under [SECURITY.md](SECURITY.md) and may merge
  without the public proposal period.
- Decisions that affect users or contributors are recorded publicly in the relevant issue,
  pull request or release notes.

## Roadmap

The public roadmap is kept as GitHub issues and milestones in this repository. Proposals for
the roadmap are welcome as issues. Priorities favour correctness, security and honest
documentation of what is and is not implemented over feature breadth.

## Releases

Releases follow semantic versioning (pre-1.0: minor versions may change behaviour). Each
release is an annotated tag on `main` with release notes listing changes, verification and
known limits. Only the latest release line receives security fixes.

## Contact

- Security vulnerabilities: GitHub private vulnerability reporting (see
  [SECURITY.md](SECURITY.md)).
- Code of Conduct reports: e-mail [contact@centralcity.ai](mailto:contact@centralcity.ai)
  with "Code of Conduct" in the subject. The mailbox is read only by the maintainers
  responsible for enforcement; reports are handled confidentially.
- Everything else: GitHub issues and discussions.
