# webos-compat

A Cloudflare Worker that takes anonymous compatibility reports from
[Local Voice](https://github.com/haywirephoenix/webos-localvoice) and
[Tailscale](https://github.com/haywirephoenix/webos-tailscale) on LG webOS TVs, and passes each one
to the app's GitHub repository. A workflow there adds it to the app's `COMPATIBILITY.md`, such as
[Local Voice's](https://github.com/haywirephoenix/webos-localvoice/blob/main/COMPATIBILITY.md).

## What a report holds

The app's name and version, the TV's model name, webOS version and firmware version, and yes or no
answers to the questions on the app's form. No IDs, no audio, nothing typed. A report is sent only
when you press Send.

Cloudflare sees the TV's address. The Worker keeps only a salted hash of it, for 30 days, to refuse
a second report of the same app version from the same address. The GitHub repositories keep only
totals for each TV model and webOS version, never single reports.

## Limits

Reports are rate limited per address and capped each day, and malformed reports are refused. The
GitHub token is a Worker secret, so the apps carry no key.

## Tests

`node test.mjs` checks the report validation and the limits against fake Cloudflare bindings.
