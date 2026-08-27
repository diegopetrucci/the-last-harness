# The Last Harness brand assets

This directory contains the canonical The Last Harness marks for repository documentation and contributor/design use. These are repository-only assets, not TLH runtime resources.

## Provenance and variants

The four marks were introduced together in commit [`f05a75b`](https://github.com/diegopetrucci/the-last-harness/commit/f05a75bc1db479a10a8440c49135441359b2adf8) (`Add TLH brand marks (#87)`, 2026-06-01). The SVG files are the vector variants; the PNG files are 1024×1024 raster variants.

| Variant | SVG | PNG | Use |
| --- | --- | --- | --- |
| Dark | [`tlh-mark-dark.svg`](tlh-mark-dark.svg) | [`tlh-mark-dark.png`](tlh-mark-dark.png) | Dark background |
| Light | [`tlh-mark-light.svg`](tlh-mark-light.svg) | [`tlh-mark-light.png`](tlh-mark-light.png) | Warm light background |

Do not change or remove an existing mark as part of unrelated documentation or packaging work. Add approved variants here with their provenance and usage guidance.

## npm exclusion

These marks are intentionally excluded from the npm package. The root [`package.json`](../../package.json) includes `docs` but explicitly excludes `!docs/brand`, so `npm pack` publishes none of this directory. The files remain available from the repository for documentation and design use.
