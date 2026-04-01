# fmirror (File Mirror)

A small TypeScript/NodeJS utility that watches one or more source folders and mirrors them to one or more destination folders.

It reads its jobs from `fmirror.config.json`, watches for changes, performs an initial full reconciliation, and supports `.fmirrorignore` files with Git-style ignore syntax.

## Features

- Watches multiple source folders
- Syncs each source to one or more destinations
- Runs an initial full reconciliation before entering watch mode
- Supports one-shot reconciliation and analysis commands
- Deletes removed files from destinations
- Supports hidden files
- Supports one or more `.fmirrorignore` files inside each source tree
- Coalesces repeated file changes on the same path before syncing
- Reserves `_fmirrorignore/` for internal operational files and always excludes it from mirroring
- Stores operational data in `_fmirrorignore/fmirror/`, including `sync-errors.log` and `queue.json`
- Can install the built CLI into `~/fmirror` and add it to `PATH`
- `.fmirrorignore` uses the same pattern syntax you already know from `.gitignore`

## How `.fmirrorignore` works

Create a `.fmirrorignore` file anywhere inside a watched source tree.

Examples:

```gitignore
node_modules/
dist/
.cache/
.env
*.log
coverage/
```

Nested `.fmirrorignore` files are supported. Each file applies to its own folder, like `.gitignore`.

See [fmirrorignore.sample.txt](samples/fmirrorignore.sample.txt) for more example patterns.

## Reserved operational folder

Each watched source root gets an automatically created `_fmirrorignore` folder.

This folder is always ignored by the app, even without any `.fmirrorignore` rule, so its contents are never mirrored to destinations.

Inside `_fmirrorignore`, the app creates `_fmirrorignore/fmirror/` to store its own state.

The file `_fmirrorignore/fmirror/sync-errors.log` stores operational errors raised during sync, full rescan, watcher handling, or queue recovery.

The file `_fmirrorignore/fmirror/queue.json` stores the in-memory file queue on disk so pending file events can be recovered and replayed after a restart.

## Requirements

- Node.js 22+
- macOS, Linux, or Windows

## Installation

### Local project setup

Clone or copy this project locally, then run:

```bash
npm install
npm run build
cp samples/config.sample.json fmirror.config.json
```

Edit `fmirror.config.json` and then start the watcher:

```bash
npm start
```

For development mode:

```bash
npm run dev
```

`npm run build` produces `dist/fmirror.js`.

`npm start` and `npm run dev` pass `./fmirror.config.json` explicitly.

If you run `node dist/fmirror.js` without arguments, the app looks for `fmirror.config.json` in the same folder as `dist/fmirror.js`.

### CLI installation

If you want to run `fmirror` directly from the terminal, build it and install the local CLI:

```bash
npm install
npm run build
npm run install:local
```

This command:

- copies the built bundle to `~/fmirror/fmirror.js`
- creates the launcher `~/fmirror/fmirror`
- appends `~/fmirror` to your shell `PATH` if needed

After installation, reload your shell or open a new terminal.

If you want the installed CLI to work without passing a config path every time, place the config here:

```bash
cp samples/config.sample.json ~/fmirror/fmirror.config.json
```

Then you can start it directly with:

```bash
fmirror
```

If your config lives somewhere else, pass it explicitly:

```bash
fmirror /absolute/path/to/fmirror.config.json
```

## Commands

- `fmirror [config-path]`: starts watch mode. This is the default command.
- `fmirror analyze [config-path]`: scans all included source files, prints the included file count and total size, and writes `_fmirrorignore/fmirror/source-analysis.log` inside each source tree.
- `fmirror reconcile [config-path]`: performs a one-shot reconciliation. Missing files are copied to each destination and extra files are removed.
- `fmirror install`: copies the built CLI to `~/fmirror`, creates the `fmirror` launcher, and appends `~/fmirror` to your shell `PATH` if needed.

Useful npm shortcuts:

- `npm run analyze`
- `npm run reconcile`
- `npm run install:local`

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

- `debounceMs`: delay used when a `.fmirrorignore` file changes before running a full reconciliation
- `fileDebounceMs`: delay used to coalesce repeated file events on the same path before syncing
- `jobs`: list of sync jobs

Each job contains:

- `name`: label shown in logs
- `source`: folder to watch
- `destinations`: one or more target folders
- `deleteMissing`: if `true`, removes files from destinations when they are deleted from the source
- `watchHidden`: if `true`, includes dotfiles during the initial sync and watcher processing

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
/Users/your-user/dev/my-project/.fmirrorignore
```

With content:

```gitignore
node_modules/
dist/
.env
*.log
```

Then run the watcher. The destination will stay updated without uploading ignored files.

## Automatic startup on macOS with launchd

Create a LaunchAgent file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.danieleperilli.fmirror</string>

    <key>WorkingDirectory</key>
    <string>/absolute/path/to/fmirror</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>node</string>
        <string>dist/fmirror.js</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/fmirror.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/fmirror-error.log</string>
</dict>
</plist>
```

Save it as:

```text
~/Library/LaunchAgents/com.danieleperilli.fmirror.plist
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.danieleperilli.fmirror.plist
```

To reload it after changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.danieleperilli.fmirror.plist
launchctl load ~/Library/LaunchAgents/com.danieleperilli.fmirror.plist
```

## Notes

- This tool mirrors files. It is not a bidirectional sync.
- Destination changes are not copied back to the source.
- If a `.fmirrorignore` file changes, the app reloads ignore rules and performs a full reconciliation.
- Directory-level moves and structural changes schedule a reconciliation automatically, so rename and move operations converge to the final tree state even when raw watcher events are noisy.
- Large bursts of file events also trigger a reconciliation fallback, which makes mass deletions and large refactors more reliable.
- When `deleteMissing` is `true`, startup and ignore reloads also remove stale files from destinations so they match the current mirrored source state.
- Failed file events stay on the persisted queue and are retried automatically until they succeed.
- For very large trees, a full reconciliation after ignore changes may take some time.
