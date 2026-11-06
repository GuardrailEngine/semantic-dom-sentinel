# Release policy

Semantic DOM Sentinel releases are distributed through GitHub Releases attached to a version tag on `main`. GitHub's source archives are the release artifacts. Public npm publishing and CDN distribution are not part of this policy; package metadata in `package.json` does not authorize publication.

No release is automatic. Create a release only after its contents and version have been explicitly approved by the project owner. Do not create a tag or release as part of an ordinary change PR, and never move or replace a tag after release. Correct a published release with a new version instead.

## Changelog and versioning

- Put concise, user-facing changes in [`CHANGELOG.md`](../CHANGELOG.md) under `Unreleased`, grouped as `Added`, `Changed`, `Fixed`, or `Security` when those categories apply. Omit routine internal maintenance unless it affects users.
- Mark incompatible public API changes as **Breaking** and include any migration guidance. Coordinate security advisories through [`SECURITY.md`](../SECURITY.md); do not put undisclosed vulnerability details in the public changelog.
- Use Semantic Versioning. Before `1.0.0`, the API is still unstable: use patch versions for compatible fixes and normally use a new `0.y.0` version for a planned feature or incompatible API change, clearly identifying breaking changes. After `1.0.0`, use major for incompatible public API changes, minor for backward-compatible features, and patch for backward-compatible fixes.
- For a release, move the completed `Unreleased` entries into a `X.Y.Z - YYYY-MM-DD` section, then add a fresh `Unreleased` section. Keep the version in `package.json` and the root package entry in `package-lock.json` in sync in a reviewed PR.

## Release checklist

1. **Approve and prepare.** Confirm the owner has approved the release, select its version, and ensure all intended changes are merged or included in a focused release PR. Review changelog entries and migration notes.
2. **Use a clean, reproducible environment.** Check out the intended commit with Node.js 22 and the committed lockfile. Run:

   ```sh
   npm ci
   npx playwright install
   npm run lint
   npm run typecheck
   npm run test:coverage
   npm run test:e2e
   npm run build
   npm pack --dry-run
   git diff --check
   ```

   Inspect the `npm pack --dry-run` file list if a package archive is being considered as a GitHub Release asset; this command does not publish it. The standard release channel remains GitHub Releases.
3. **Review through a PR.** Open the version/changelog update as a PR to `main`. Resolve failures and confirm both required GitHub checks, `verify` and `coverage`, pass. Merge only under the repository's existing branch rules; do not change branch protection for a release.
4. **Tag the merged commit.** After the PR is merged, verify the exact `main` commit and package version. Create the immutable `vX.Y.Z` tag on that commit; do not tag a PR head or retag a released version.
5. **Publish on GitHub only.** Create a GitHub Release from that tag and use the matching changelog section as its notes. Do not run `npm publish` or publish to a CDN.
6. **Verify the result.** Confirm the release page, tag, version, notes, and target commit agree. If a correction is needed, prepare a new version rather than editing or moving the released tag.
