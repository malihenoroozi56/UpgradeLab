# Changesets

Run `pnpm changeset` for every user-visible change and describe the effect on configuration, reports, the
CLI or the plugin API. Commit the generated Markdown file with the change.

The release workflow uses Changesets to open a version PR. Merging it publishes the packages and tags the
release. Do not edit package versions by hand.
