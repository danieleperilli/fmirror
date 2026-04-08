# fmirror (File Mirror)

A small TypeScript/NodeJS utility that watches one or more source folders and mirrors them to one or more destination folders.

It reads its jobs from a JSON config file, watches for changes, performs an initial full reconciliation, and supports `.fmirror-ignore` files with Git-style ignore syntax.

## Features

- Watches multiple source folders
- Syncs each source to one or more destinations
- Runs an initial full reconciliation before entering watch mode
- Supports one-shot reconciliation and analysis commands
- Deletes removed files from destinations
- Preserves empty directories
- Supports hidden files
- Supports one or more `.fmirror-ignore` files inside each source tree
- Coalesces repeated file changes on the same path before syncing
- Reserves `.fmirror/` for internal operational files and always excludes it from mirroring
- Stores operational data in `.fmirror/`, including `sync-error.log` and `queue.json`
- Can install the CLI globally in `~/fmirror` and bootstrap a source folder with `.fmirror/config.json`, `.fmirror-ignore`, and a macOS LaunchAgent
- `.fmirror-ignore` uses the same pattern syntax you already know from `.gitignore`

## How `.fmirror-ignore` works

Create a `.fmirror-ignore` file anywhere inside a watched source tree.

Examples:

```gitignore
node_modules/
dist/
.cache/
.env
*.log
coverage/
```

Nested `.fmirror-ignore` files are supported. Each file applies to its own folder, like `.gitignore`.

See [fmirror-ignore.template](templates/fmirror-ignore.template) for more example patterns.

## Reserved operational folder

Each watched source root gets an automatically created `.fmirror` folder.

This folder is always ignored by the app, even without any `.fmirror-ignore` rule, so its contents are never mirrored to destinations.

Inside `.fmirror`, the app stores its own state.

The file `.fmirror/sync-error.log` stores operational errors raised during sync, full rescan, watcher handling, or queue recovery.

The file `.fmirror/queue.json` stores the in-memory file queue on disk so pending file events can be recovered and replayed after a restart.

## Requirements

- Node.js 22+
- Watchman available on `PATH` for watch mode
- macOS, Linux, or Windows

## Installation

### Watchman

fmirror requires Watchman.

See the official Watchman installation guide for platform-specific packages:

- https://facebook.github.io/watchman/docs/install

### fmirror

```bash
npm install
npm run install:local
```

This command:

- build fmirror
- copies the built bundle to `~/fmirror/fmirror.js`
- creates the launcher `~/fmirror/fmirror`
- copies the install templates to `~/fmirror/templates`
- appends `~/fmirror` to your shell `PATH` if needed

After that (and reloading your shell), set up a mirror:

```bash
fmirror setup -s /absolute/path/to/source -d /absolute/path/to/destination
```

The `setup` command:

- creates `/absolute/path/to/source/.fmirror/config.json`
- creates `/absolute/path/to/source/.fmirror-ignore` if it does not already exist
- on macOS, creates `~/Library/LaunchAgents/com.fmirror-source-folder-slug.plist`
- on macOS, reloads that LaunchAgent automatically
- on macOS, creates a symlink to the installed plist inside `/absolute/path/to/source/.fmirror/`

The generated config always points to the source and destination you pass to `setup`.

If `-s` or `-d` is missing, `setup` stops with an error.

If the global CLI is missing, `setup` also stops with an error and asks you to run `fmirror install` first.

The install flow uses the built `dist/fmirror.js` only as the source bundle for the global installation, so `npm run build` must succeed first.

After the first install, reload your shell or open a new terminal if you want to use `fmirror` directly from `PATH`.

To run the generated config manually:

```bash
fmirror /absolute/path/to/source/.fmirror/config.json
```

## Commands

- `fmirror [config-path]`: starts watch mode. This is the default command.
- `fmirror -fast-start [config-path]`: starts watch mode without the initial full reconciliation. Use this only when you explicitly want a faster startup and accept that destinations may stay stale until later events or a manual reconciliation.
- `fmirror analyze [config-path]`: scans all included source files, prints the included file count and total size, and writes `.fmirror/source-analysis.log` inside each source tree.
- `fmirror reconcile [config-path]`: performs a one-shot reconciliation. Missing files are copied to each destination and extra files are removed.
- `fmirror install`: installs or refreshes the global CLI in `~/fmirror` and updates your shell `PATH` when needed.
- `fmirror setup -s <source-path> -d <destination-path>`: creates `source/.fmirror/config.json`, ensures `source/.fmirror-ignore`, and on macOS installs a LaunchAgent for that source automatically.

Useful npm shortcuts:

- `npm run analyze`
- `npm run reconcile`
- `npm run install:local`

By default, watch mode performs a full reconciliation before the watcher becomes active. During that pass, destinations are checked using `name + size + mtime`. Pass `-fast-start` or `--fast-start` only if you want to skip that initial sync.

## Config format

Example `fmirror.config.json`:

```json
{
    "debounceMs": 400,
    "fileDebounceMs": 1500,
    "jobs": [
        {
            "name": "my-project",
            "source": "/Users/your-user/dev/my-project",
            "destinations": [
                "/Users/your-user/Library/CloudStorage/GoogleDrive-your@email.com/My Drive/backups/my-project",
                "/Volumes/NAS/backups/my-project"
            ],
            "deleteMissing": true,
            "watchHidden": true
        }
    ]
}
```

### Config fields

- `debounceMs`: delay used when a `.fmirror-ignore` file changes before running a full reconciliation
- `fileDebounceMs`: delay used to coalesce repeated file events on the same path before syncing
- `jobs`: list of sync jobs

Each job contains:

- `name`: label shown in logs
- `source`: folder to watch
- `destinations`: one or more target folders expressed as strings
- `deleteMissing`: if `true`, removes files from destinations when they are deleted from the source
- `watchHidden`: if `true`, includes dotfiles during the initial sync and watcher processing

Example:

```json
"destinations": [
    "/Volumes/NAS/backups/my-project"
]
```

Relative `source` and `destinations` paths are resolved from the directory that contains `fmirror.config.json`.

Source and destination roots must not overlap each other, and destinations must not overlap other destinations. This prevents mirror loops and accidental deletions.

## Example setup for Google Drive

If you want to avoid syncing `node_modules` into Google Drive, keep your real project outside Google Drive and use this tool to mirror only the files you want.

Example:

Source project folder:

```text
/Users/your-user/dev/my-project
```

Destination inside Google Drive:

```text
/Users/your-user/Library/CloudStorage/GoogleDrive-your@email.com/My Drive/backups/my-project
```

Inside your source project, create:

```text
/Users/your-user/dev/my-project/.fmirror-ignore
```

With content:

```gitignore
node_modules/
dist/
.env
*.log
```

Then run the watcher. The destination will stay updated without uploading ignored files.

## Git repositories

The recommended way to mirror a Git repository is to mirror the working tree only, with a minimal files and folders from the `.git` directory needed for bootstrapping.

Recommended `.fmirror-ignore` content for Git repositories:

```gitignore
**/.git/**
!**/.git/
!**/.git/HEAD
!**/.git/config
!**/.git/objects

!**/.git/refs/
!**/.git/info/
!**/.git/info/sparse-checkout
```

This configuration ignores all `.git` files and folders except the minimal set needed to restore the full `.git` directory in the mirrored copy.
After the first mirror, you can run the following commands inside the mirrored copy to restore a working Git repository:

```bash
git fetch --all --tags
git checkout -B main origin/main -f
```

If `origin/main` already exists locally, you can also use:

```bash
git reset --hard origin/main
```

Replace `main` with the correct default branch for your repository.

If the repository uses submodules, run:

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

## Automatic startup on macOS with launchd

`fmirror setup -s <source-path> -d <destination-path>` creates and installs the LaunchAgent automatically on macOS.

The installed file name is:

```text
~/Library/LaunchAgents/com.fmirror-source-folder-slug.plist
```

The same file is also linked inside:

```text
/absolute/path/to/source/.fmirror/fmirror-source-folder-slug.plist
```

If you want to edit the template used to generate it, start from [launch-agent.template.plist](templates/launch-agent.template.plist).

For `launchd`, prefer absolute paths and do not rely on the shell `PATH`. The generated agent calls `node` directly with the globally installed `~/fmirror/fmirror.js` bundle and the generated `source/.fmirror/config.json`.

For large trees on macOS, the generated LaunchAgent raises `NumberOfFiles` to `200000` so the watcher does not inherit the default low `launchd` open-files limit.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.fmirror.source-folder-slug</string>

    <key>WorkingDirectory</key>
    <string>/absolute/path/to/source</string>

    <key>ProgramArguments</key>
    <array>
        <string>/absolute/path/to/node</string>
        <string>/Users/your-user/fmirror/fmirror.js</string>
        <string>/absolute/path/to/source/.fmirror/config.json</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/absolute/path/to/source/.fmirror/launchd.log</string>

    <key>StandardErrorPath</key>
    <string>/absolute/path/to/source/.fmirror/launchd-error.log</string>
</dict>
</plist>
```

To run the same config interactively:

```bash
fmirror /absolute/path/to/source/.fmirror/config.json
```

To reload it after changes:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.fmirror-source-folder-slug.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.fmirror-source-folder-slug.plist
```

## Notes

- This tool mirrors files. It is not a bidirectional sync.
- Destination changes are not copied back to the source.
- If a `.fmirror-ignore` file changes, the app reloads ignore rules and performs a full reconciliation.
- Watch mode also asks Watchman to suppress notifications for directories that are currently ignored, and refreshes that subscription when `.fmirror-ignore` changes.
- Watch mode uses Watchman as the only watcher backend and fails fast when the `watchman` command is not available.
- Directory additions are mirrored by syncing the new subtree immediately, while directory removals and other structural changes still schedule a reconciliation so rename and move operations converge to the final tree state even when raw watcher events are noisy.
- Large bursts of file events also trigger a reconciliation fallback, which makes mass deletions and large refactors more reliable.
- When `deleteMissing` is `true`, startup and ignore reloads also remove stale files from destinations so they match the current mirrored source state.
- Failed file events stay on the persisted queue and are retried automatically until they succeed.
- For very large trees, a full reconciliation after ignore changes may take some time.
