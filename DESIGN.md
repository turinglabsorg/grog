# Grog board

The live page served by `grog serve` for a host whose `~/.grog/sites.json` entry is `{ "board": true }`.

## Look

Black page, white type, one-pixel white lines. It should read as a terminal, not as a dashboard product.

- Background `#000`, foreground `#fff`, borders `1px solid #fff`.
- Type is `ui-monospace, "SF Mono", Menlo, Consolas, monospace` at 14px. Body line-height is 1.45. The ASCII wordmark is `white-space: pre`, line-height 1, ligatures off, and every line of the wordmark is the same width.
- The password field is 16px with a 44px target so a phone does not zoom on focus. Buttons match that target.
- At 721px and wider, tables use `white-space: nowrap`, `width: max-content`, and `min-width: 100%`. A table that is wider than the window scrolls sideways inside its box.
- At 720px and below there are no sideways tables. Each site, day, page, referral, campaign, country, and log line is a stacked block. Text wraps. The wordmark uses `clamp(8px, 2.8vw, 13px)` so the five lines stay intact. The password form is a column, full width, still 16px and 44px tall.
- No second color, no radius, no shadow, no imagery besides the GROG wordmark.

## Page

Logged out, the page is the wordmark and a password form. Logged in, it lists each site (host, tunnel state, kind, today's views, today's visitors), a log of recent documents (time on this device, host, path, country, referral, campaign, newest first, up to 100 of the last 500), the last seven local days, today's paths, today's referrals (the previous site, or direct), today's campaigns (utm source, medium and name), and today's countries (a two-letter code). The viewer's own polls of `/api/snapshot` are not views. The log keeps the path that was requested. It does not keep the query string or the address.

A short line under the tables says what a view is. Scanner paths are refused and not counted. A known bot is still served and not counted. The country is where the visitor's network is registered. The address is not stored. No flag, no color for a country: the code is the cell.
