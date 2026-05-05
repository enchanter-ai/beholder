# Release Ceremony

The Enchanter monorepo ships ten plugin packages (`@enchanter-ai/plugin-*`) in
lockstep with the root `enchanter` version. Releases are gated on a human
ceremony — the publish step runs in CI, but only after a maintainer has
bumped versions, tagged, and pushed.

The root `enchanter` package itself is `private: true` and is not pushed to
the npm registry. Only the `packages/*` plugins publish.

## Prerequisites

- `NPM_TOKEN` secret configured on the GitHub repository (an npm automation
  token with publish rights to the `@enchanter-ai` scope).
- Working tree clean on `main`.
- `npm test` and `npm run typecheck` green locally.

## Steps

### 1. Bump versions

```bash
npm run release:prep -- --version 0.4.0
```

This rewrites:

- `package.json` (root) `version` -> `0.4.0`
- `packages/*/package.json` `version` -> `0.4.0`
- `packages/*/package.json` `peerDependencies.enchanter` -> `^0.4.0`

It prints a summary of every field touched and exits 0. Inspect the diff
before committing.

### 2. Sanity check

```bash
npm run release:dry
```

This walks every package, validates lockstep (`name`, `version`,
`peerDependencies.enchanter`, `files` includes `dist`) and runs
`npm pack --dry-run` for each. It never invokes `npm publish`.

If validation or pack-checks fail, fix the offending package and re-run.

### 3. Commit + tag + push

```bash
git commit -am "chore: bump to v0.4.0"
git tag v0.4.0
git push origin main --tags
```

### 4. CI publishes automatically

The `.github/workflows/publish.yml` workflow triggers on the `v*.*.*` tag
push. It:

1. Fails closed if `NPM_TOKEN` secret is unset.
2. Runs `npm ci`, `npm test`, `npm run build`.
3. Invokes `node --import tsx scripts/publish-packages.ts --publish`, which
   runs `npm publish --workspace @enchanter-ai/plugin-<name> --access public`
   for each plugin.

Watch the run in GitHub Actions. On success, all ten packages are live on
npm at `@enchanter-ai/plugin-*@<new-version>`.

### 5. If CI fails partway

The publish script is tolerant of partial failure. The job log lists which
packages succeeded and which failed (for example, the registry rejected one
manifest, or hit a transient timeout). Already-published packages will be
skipped — npm refuses to overwrite a published version.

To finish the release:

- Fix the root cause for the failing packages (manifest issue, network).
- Re-run the workflow with `gh workflow run publish.yml --ref v0.4.0`, or
  delete the tag, fix locally, retag, and re-push.
- Alternatively, publish the remaining packages manually:
  ```bash
  NPM_TOKEN=... NODE_AUTH_TOKEN=$NPM_TOKEN \
    npm publish --workspace @enchanter-ai/plugin-<name> --access public
  ```

## Notes on the `peerDependencies.enchanter` range

In v0.3.x the peer range was relaxed to `>=0.2.0` because `enchanter` itself
is `private: true` and not on the registry — there is no published version
the peer range needed to match. After publishing the plugins, end-user
applications will install `enchanter` (when/if it goes public) plus selected
plugins; the peer range exists to express compatibility, not to gate
installs.

`release-prep.ts` retightens the range to `^<root-version>` on each bump so
the published manifests express a clean semver-major compatibility statement.
If `enchanter` itself remains `private: true` for v0.4 and beyond, the
practical effect is informational; if it eventually publishes, the range is
already correct.
