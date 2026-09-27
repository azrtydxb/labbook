# Questions procoder cannot answer for you

Written 2026-09-27 07:58 UTC.

Answer each one by writing a line beginning `Answer: ` under it, then
hand the file back with `procoder ask --file .procoder/ask/QA.md`.
Leave the `Key:` lines alone — they are what ties an answer to its question.

## Q1: [decision] decisions.md

Key: 62a39568eb6f
Question: Kuvryn Sync image write-back credential for azrtydxb/labbook

- You create a fine-grained GitHub token (Contents: read/write on azrtydxb/labbook) and load it with a kubectl command
- I create a write-enabled deploy key with gh and store its private half only in the cluster Secret
- No write-back: Kuvryn Sync syncs Git only; image bumps stay a manual commit of the digest

Answer: Deploy key created by Claude with gh (write access, azrtydxb/labbook only); private half only in the cluster Secret (user, 2026-09-27)
