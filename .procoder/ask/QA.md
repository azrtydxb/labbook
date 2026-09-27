# Questions procoder cannot answer for you

Written 2026-09-27 08:03 UTC.

Answer each one by writing a line beginning `Answer: ` under it, then
hand the file back with `procoder ask --file .procoder/ask/QA.md`.
Leave the `Key:` lines alone — they are what ties an answer to its question.

## Q1: [decision] decisions.md

Key: cd8c15ead87f
Question: Kuvryn Sync controller trust of the cluster CA (for ImagePolicy registry scans)

- Mount the cluster CA into kuvryn-sync-controller-manager and set SSL_CERT_FILE (affects every app Kuvryn Sync manages)
- Add a CA setting to ImagePolicy in kuvryn-sync itself (code change in azrtydxb/kuvryn-sync, then upgrade)
- Leave it: image bumps stay a manual commit of the digest

Answer: Add a CA setting to ImagePolicy in azrtydxb/kuvryn-sync, release and upgrade (user, 2026-09-27)
