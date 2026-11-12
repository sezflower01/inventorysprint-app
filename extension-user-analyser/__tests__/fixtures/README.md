# Fixtures

**These are SYNTHETIC, hand-written pages, not captured Amazon HTML.**

That distinction matters and must not be forgotten:

- They prove the parser's *logic* — the selector order, the never-guess rule,
  the range handling, the label-based BSR scan. That is real coverage and it
  will catch a regression in this folder.
- They do **not** prove the parser survives Amazon. Amazon's real markup is
  malformed in places, carries a dozen A/B layout variants, and changes
  without notice. Only a real capture catches that drift, and a green suite
  here is not evidence the panel works in the wild.

Real captures were not committed because an Amazon product page is ~2 MB of
third-party HTML whose copyright is not ours, and because a capture is a
snapshot of one variant on one day.

**Before trusting this parser in production**, save a handful of real pages
locally (DevTools → right-click the `<html>` node → Copy outerHTML), keep them
OUTSIDE the repo, and run the same suite against them.
