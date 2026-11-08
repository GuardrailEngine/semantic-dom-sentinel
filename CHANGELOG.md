# Changelog

Notable, user-facing changes to Semantic DOM Sentinel are recorded here. This project uses Semantic Versioning where applicable. See the [release policy](docs/releasing.md) for versioning rules and the GitHub-only release process.

## [Unreleased]

## [0.1.1] - 2026-11-08

### Changed
- Remove CDN package fields and guidance; distribution remains GitHub-only.

### Fixed
- Recheck selector membership across the affected root after observed DOM mutations, including sibling-position and relational selectors.

## [0.1.0] - 2026-11-07
### Added
- Initial early-MVP release of a TypeScript library for monitoring explicitly selected DOM roots and delivering structured, alert-only notifications for additions, removals, and configured attribute or text changes.
- Add in-memory baselines, allowlists for expected values, and an optional diagnostic inspector overlay.
- Provide ESM, CommonJS, browser, and TypeScript declaration package entry points.
