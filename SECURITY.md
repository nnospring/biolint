# Security

biolint reads untrusted files, so parsing bugs matter. If you find an input that makes it crash, hang, or use memory
without bound, please report it privately through the repository's "Report a vulnerability" button
(GitHub private vulnerability reporting) rather than in a public issue. Include the input, or a script that generates it.

What to expect: the linter never executes content from the files it reads, makes no network requests, and writes
only when asked to with `--fix`. The playground runs entirely in the browser and uploads nothing.

Only the latest release is supported.
