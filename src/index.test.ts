import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "fs-extra";
import type { IJobRuntime } from "./interfaces";
import { analyzeRuntime, buildWatchmanSubscribeCommand, createInstalledLauncherContent, createInstallPaths, createPathExportBlock, createRuntime, createSourceFolderSlug, getConfigPath, handleDirectoryEvent, handleFileEvent, installGlobalCli, isWatcherLimitError, normalizeWatchmanEntryType, parseCliArguments, parseSetupArguments, queueFileEvent, readConfig, reconcileRuntimes, renderInstallConfigContent, renderLaunchAgentTemplate, runFullSync, runInitialSync, setupMirror, shouldLogWatcherError, syncFile } from "./index";

test("getConfigPath prefers the CLI argument", async () => {
    const resolvedPath = getConfigPath([
        "node",
        "/tmp/fmirror.js",
        "./custom.config.json"
    ]);

    assert.equal(resolvedPath, path.resolve("./custom.config.json"));
});

test("getConfigPath reads the config after a command name", async () => {
    const resolvedPath = getConfigPath([
        "node",
        "/tmp/dist/fmirror.js",
        "analyze",
        "./compare.config.json"
    ]);

    assert.equal(resolvedPath, path.resolve("./compare.config.json"));
});

test("getConfigPath ignores fast-start flags when locating the config", async () => {
    const resolvedPath = getConfigPath([
        "node",
        "/tmp/dist/fmirror.js",
        "watch",
        "-fast-start",
        "./compare.config.json"
    ]);

    assert.equal(resolvedPath, path.resolve("./compare.config.json"));
});

test("getConfigPath falls back to fmirror.config.json next to the app", async () => {
    const resolvedPath = getConfigPath([
        "node",
        "/tmp/dist/fmirror.js"
    ]);

    assert.equal(resolvedPath, "/tmp/dist/fmirror.config.json");
});

test("parseCliArguments keeps backward compatibility for watch mode", async () => {
    const parsedArguments = parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "./custom.config.json"
    ]);

    assert.deepEqual(parsedArguments, {
        command: "watch",
        configPath: "./custom.config.json",
        fastStart: false
    });
});

test("parseCliArguments supports explicit commands and aliases", async () => {
    assert.deepEqual(parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "reconcile",
        "./custom.config.json"
    ]), {
        command: "reconcile",
        configPath: "./custom.config.json",
        fastStart: false
    });

    assert.deepEqual(parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "stats",
        "./custom.config.json"
    ]), {
        command: "analyze",
        configPath: "./custom.config.json",
        fastStart: false
    });
});

test("parseCliArguments supports fast-start in watch mode", async () => {
    assert.deepEqual(parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "-fast-start",
        "./custom.config.json"
    ]), {
        command: "watch",
        configPath: "./custom.config.json",
        fastStart: true
    });

    assert.deepEqual(parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "watch",
        "./custom.config.json",
        "--fast-start"
    ]), {
        command: "watch",
        configPath: "./custom.config.json",
        fastStart: true
    });
});

test("parseSetupArguments resolves source and destination paths", async () => {
    const parsedArguments = parseSetupArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "setup",
        "-d",
        "../destination-folder",
        "-s",
        "./source-folder"
    ]);

    assert.deepEqual(parsedArguments, {
        sourcePath: path.resolve("./source-folder"),
        destinationPath: path.resolve("../destination-folder")
    });
});

test("parseSetupArguments rejects missing source and destination flags", async () => {
    assert.throws(() => {
        parseSetupArguments([
            "node",
            "/tmp/dist/fmirror.js",
            "setup"
        ]);
    }, /Setup requires both -s <source-path> and -d <destination-path>/);
});

test("isWatcherLimitError only reacts to native watcher limit errors", async () => {
    assert.equal(isWatcherLimitError({ code: "EMFILE" }), true);
    assert.equal(isWatcherLimitError({ code: "ENOSPC" }), true);
    assert.equal(isWatcherLimitError({ code: "EACCES" }), false);
});

test("shouldLogWatcherError suppresses repeated watcher errors inside the throttle window", async () => {
    const runtime = createRuntimeStub();

    assert.equal(shouldLogWatcherError(runtime, new Error("watch failed")), true);
    assert.equal(shouldLogWatcherError(runtime, new Error("watch failed")), false);
    assert.equal(runtime.watcherErrorState?.suppressedCount, 1);
    assert.equal(shouldLogWatcherError(runtime, new Error("different failure")), true);
});

test("shouldLogWatcherError groups watcher limit errors under one throttled message", async () => {
    const runtime = createRuntimeStub();

    assert.equal(shouldLogWatcherError(runtime, { code: "EMFILE", message: "too many open files" }), true);
    assert.equal(shouldLogWatcherError(runtime, { code: "ENOSPC", message: "system limit for number of file watchers reached" }), false);
    assert.equal(runtime.watcherErrorState?.suppressedCount, 1);
});

test("normalizeWatchmanEntryType maps Watchman type codes to mirrorable entry types", async () => {
    assert.equal(normalizeWatchmanEntryType("d"), "directory");
    assert.equal(normalizeWatchmanEntryType("f"), "file");
    assert.equal(normalizeWatchmanEntryType("l"), "file");
    assert.equal(normalizeWatchmanEntryType("x"), undefined);
});

test("buildWatchmanSubscribeCommand includes relative_root only when it is provided", async () => {
    assert.deepEqual(buildWatchmanSubscribeCommand("/tmp/root", "fmirror-test", "c:1:2"), [
        "subscribe",
        "/tmp/root",
        "fmirror-test",
        {
            fields: [
                "name",
                "exists",
                "type"
            ],
            since: "c:1:2"
        }
    ]);
    assert.deepEqual(buildWatchmanSubscribeCommand("/tmp/root", "fmirror-test", "c:1:2", "nested/project"), [
        "subscribe",
        "/tmp/root",
        "fmirror-test",
        {
            fields: [
                "name",
                "exists",
                "type"
            ],
            since: "c:1:2",
            relative_root: "nested/project"
        }
    ]);
});

/**
 * Creates and returns a temporary directory for a test case.
 */
async function createTempDirectory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "fmirror-"));
}

/**
 * Creates a temporary template directory used by install-related tests.
 *
 * @param rootPath Root directory that should receive the template files.
 */
async function createTemplateDirectory(rootPath: string): Promise<string> {
    const templateDirectoryPath = path.join(rootPath, "templates");

    await fs.ensureDir(templateDirectoryPath);
    await fs.writeFile(path.join(templateDirectoryPath, "config.template.json"), `${JSON.stringify({
        debounceMs: 400,
        fileDebounceMs: 1500,
        jobs: [
            {
                name: "template-job",
                source: "/template/source",
                destinations: [
                    "/template/destination"
                ],
                deleteMissing: true,
                watchHidden: true
            }
        ]
    }, null, 4)}\n`, "utf8");
    await fs.writeFile(path.join(templateDirectoryPath, "fmirror-ignore.template"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(templateDirectoryPath, "launch-agent.template.plist"), [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<plist version=\"1.0\">",
        "<dict>",
        "    <key>Label</key>",
        "    <string>{{LABEL}}</string>",
        "    <key>WorkingDirectory</key>",
        "    <string>{{WORKING_DIRECTORY}}</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        "        <string>{{NODE_PATH}}</string>",
        "        <string>{{BUNDLE_PATH}}</string>",
        "        <string>{{CONFIG_PATH}}</string>",
        "    </array>",
        "    <key>SoftResourceLimits</key>",
        "    <dict>",
        "        <key>NumberOfFiles</key>",
        "        <integer>200000</integer>",
        "    </dict>",
        "    <key>HardResourceLimits</key>",
        "    <dict>",
        "        <key>NumberOfFiles</key>",
        "        <integer>200000</integer>",
        "    </dict>",
        "    <key>StandardOutPath</key>",
        "    <string>{{STANDARD_OUT_PATH}}</string>",
        "    <key>StandardErrorPath</key>",
        "    <string>{{STANDARD_ERROR_PATH}}</string>",
        "</dict>",
        "</plist>",
        ""
    ].join("\n"), "utf8");

    return templateDirectoryPath;
}

/**
 * Captures console.log output emitted while the provided callback runs.
 *
 * @param callback Async operation executed while console.log is intercepted.
 */
async function captureConsoleLogs(callback: () => Promise<void>): Promise<string[]> {
    const originalConsoleLog = console.log;
    const capturedLogs: string[] = [];

    console.log = (...args: unknown[]): void => {
        capturedLogs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
        await callback();
    } finally {
        console.log = originalConsoleLog;
    }

    return capturedLogs;
}

/**
 * Polls until the provided predicate becomes true or the timeout elapses.
 *
 * @param predicate Async predicate that determines completion.
 * @param timeoutMs Maximum time to wait.
 */
async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
        if (await predicate()) {
            return;
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });
    }

    throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

/**
 * Clears timers and pending writes owned by a runtime created during tests.
 *
 * @param runtime Runtime to dispose.
 */
async function disposeRuntime(runtime: IJobRuntime): Promise<void> {
    if (runtime.fullSyncTimer) {
        clearTimeout(runtime.fullSyncTimer);
    }

    if (runtime.fileEventBurstTimer) {
        clearTimeout(runtime.fileEventBurstTimer);
    }

    for (const queuedEvent of runtime.queuedFileEvents.values()) {
        if (queuedEvent.debounceTimer) {
            clearTimeout(queuedEvent.debounceTimer);
        }

        if (queuedEvent.retryTimer) {
            clearTimeout(queuedEvent.retryTimer);
        }
    }

    await runtime.queuePersistencePromise;

    if (runtime.watcher) {
        await runtime.watcher.close();
    }
}

/**
 * Creates a lightweight runtime stub for pure watcher helper tests.
 */
function createRuntimeStub(): IJobRuntime {
    return {
        config: {
            name: "watcher-test",
            source: "/tmp/source",
            destinations: [],
            deleteMissing: true,
            watchHidden: true
        },
        ignoreFiles: [],
        internalAppDirectory: "/tmp/source/.fmirror",
        errorLogPath: "/tmp/source/.fmirror/sync-error.log",
        queueFilePath: "/tmp/source/.fmirror/queue.json",
        fileEventDebounceMs: 25,
        queuedFileEvents: new Map(),
        recoveredQueuePaths: [],
        queuePersistencePromise: Promise.resolve(),
        fileEventBurstCount: 0,
        watcherErrorState: undefined
    };
}

test("readConfig rejects overlapping roots", async () => {
    const tempDirectory = await createTempDirectory();
    const configPath = path.join(tempDirectory, "fmirror.config.json");

    await fs.ensureDir(path.join(tempDirectory, "source"));
    await fs.writeJson(configPath, {
        jobs: [
            {
                name: "job-a",
                source: "./source",
                destinations: [
                    "./source/backup"
                ]
            }
        ]
    }, { spaces: 4 });

    await assert.rejects(async () => {
        await readConfig(configPath);
    }, /Path overlap detected/);
});

test("readConfig rejects destination objects", async () => {
    const tempDirectory = await createTempDirectory();
    const configPath = path.join(tempDirectory, "fmirror.config.json");

    await fs.ensureDir(path.join(tempDirectory, "source"));
    await fs.writeJson(configPath, {
        jobs: [
            {
                name: "job-a",
                source: "./source",
                destinations: [
                    {
                        path: "./secondary-destination"
                    }
                ]
            }
        ]
    }, { spaces: 4 });

    await assert.rejects(async () => {
        await readConfig(configPath);
    }, /must be a non-empty string/);
});

test("runFullSync removes stale and ignored destination entries", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(path.join(sourcePath, "docs"));
    await fs.writeFile(path.join(sourcePath, "docs", "readme.txt"), "docs", "utf8");
    await fs.writeFile(path.join(sourcePath, "keep.txt"), "keep", "utf8");
    await fs.writeFile(path.join(sourcePath, "ignored.txt"), "ignored", "utf8");
    await fs.writeFile(path.join(sourcePath, ".fmirror-ignore"), "ignored.txt\nlegacy/\n", "utf8");

    await fs.ensureDir(path.join(destinationPath, "legacy"));
    await fs.writeFile(path.join(destinationPath, "legacy", "file.txt"), "legacy", "utf8");
    await fs.writeFile(path.join(destinationPath, "stale.txt"), "stale", "utf8");
    await fs.writeFile(path.join(destinationPath, "ignored.txt"), "stale-ignored", "utf8");

    const runtime = await createRuntime({
        name: "sync-job",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal(await fs.readFile(path.join(destinationPath, "keep.txt"), "utf8"), "keep");
        assert.equal(await fs.readFile(path.join(destinationPath, "docs", "readme.txt"), "utf8"), "docs");
        assert.equal(await fs.pathExists(path.join(destinationPath, "ignored.txt")), false);
        assert.equal(await fs.pathExists(path.join(destinationPath, "legacy")), false);
        assert.equal(await fs.pathExists(path.join(destinationPath, "stale.txt")), false);
        assert.equal(await fs.pathExists(path.join(destinationPath, ".fmirror-ignore")), false);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("runFullSync skips source files that disappear during source scanning", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const stableFilePath = path.join(sourcePath, "stable.txt");
    const transientFilePath = path.join(sourcePath, "transient.txt");
    const mutableFs = fs as typeof fs & {
        stat: typeof fs.stat;
    };
    const originalStat = fs.stat.bind(fs);
    let transientRemoved = false;

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(stableFilePath, "stable", "utf8");
    await fs.writeFile(transientFilePath, "transient", "utf8");

    const runtime = await createRuntime({
        name: "skip-vanished-source",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    mutableFs.stat = (async (targetPath: Parameters<typeof fs.stat>[0]) => {
        if (path.resolve(String(targetPath)) === transientFilePath && !transientRemoved) {
            transientRemoved = true;
            await fs.remove(transientFilePath);
        }

        return originalStat(targetPath);
    }) as typeof fs.stat;

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal(await fs.readFile(path.join(destinationPath, "stable.txt"), "utf8"), "stable");
        assert.equal(await fs.pathExists(path.join(destinationPath, "transient.txt")), false);
    } finally {
        mutableFs.stat = originalStat;
        await disposeRuntime(runtime);
    }
});

test("runFullSync logs sync entries outside reconcile", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "nested", "file.txt");

    await fs.ensureDir(path.dirname(sourceFilePath));
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");

    const runtime = await createRuntime({
        name: "truncated-sync-log",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const capturedLogs = await captureConsoleLogs(async () => {
            await runFullSync(runtime, "Initial sync");
        });
        const normalizedLogs = capturedLogs.map((entry) => entry.replace(/^\[[^\]]+\] /, ""));

        assert.equal(normalizedLogs.includes("Synced directory nested to 1 destination(s)."), true);
        assert.equal(normalizedLogs.includes("Synced nested/file.txt"), true);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile suppresses duplicate sync logs inside the deduplication window", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");

    const runtime = await createRuntime({
        name: "deduped-sync-log",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const capturedLogs = await captureConsoleLogs(async () => {
            await syncFile(runtime, sourceFilePath);
            await syncFile(runtime, sourceFilePath);
        });
        const normalizedLogs = capturedLogs.map((entry) => entry.replace(/^\[[^\]]+\] /, ""));
        const syncLogs = normalizedLogs.filter((entry) => entry === "Synced keep.txt");

        assert.equal(syncLogs.length, 1);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("sync logs trim launchd.log when it grows beyond the size limit", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const launchdLogPath = path.join(sourcePath, ".fmirror", "launchd.log");
    const oversizedLogContent = `${"[head-marker]\n"}${"x".repeat(6 * 1024 * 1024)}\n[tail-marker]\n`;

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");

    const runtime = await createRuntime({
        name: "trim-launchd-log",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.writeFile(launchdLogPath, oversizedLogContent, "utf8");
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 1100);
        });
        await syncFile(runtime, sourceFilePath);

        await waitForCondition(async () => {
            const launchdLogStats = await fs.stat(launchdLogPath);
            return launchdLogStats.size < Buffer.byteLength(oversizedLogContent, "utf8");
        }, 2000);

        const trimmedLogContent = await fs.readFile(launchdLogPath, "utf8");
        assert.equal(trimmedLogContent.includes("launchd.log truncated after exceeding"), true);
        assert.equal(trimmedLogContent.includes("[tail-marker]"), true);
        assert.equal(trimmedLogContent.includes("[head-marker]"), false);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("reconcileRuntimes suppresses per-entry sync logs", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "docs", "readme.txt");

    await fs.ensureDir(path.dirname(sourceFilePath));
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "docs", "utf8");

    const runtime = await createRuntime({
        name: "silent-reconcile-log",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const capturedLogs = await captureConsoleLogs(async () => {
            await reconcileRuntimes([
                runtime
            ]);
        });
        const normalizedLogs = capturedLogs.map((entry) => entry.replace(/^\[[^\]]+\] /, ""));

        assert.equal(await fs.readFile(path.join(destinationPath, "docs", "readme.txt"), "utf8"), "docs");
        assert.equal(normalizedLogs.some((entry) => entry.startsWith("Synced ")), false);
        assert.equal(normalizedLogs.includes("Manual reconciliation started."), true);
        assert.equal(normalizedLogs.includes("Manual reconciliation completed."), true);
        assert.equal(normalizedLogs.includes("Reconciled 1 job(s)."), true);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile skips copying during reconciliation when size and mtime already match", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const sourceTimestamp = new Date("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.writeFile(destinationFilePath, "payload", "utf8");
    await fs.utimes(sourceFilePath, sourceTimestamp, sourceTimestamp);
    await fs.utimes(destinationFilePath, sourceTimestamp, sourceTimestamp);

    const runtime = await createRuntime({
        name: "skip-identical-copy",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const sourceStats = await fs.stat(sourceFilePath);
        await syncFile(runtime, sourceFilePath, {
            size: sourceStats.size,
            mtimeMs: sourceStats.mtimeMs
        }, true);

        const destinationStats = await fs.stat(destinationFilePath);
        assert.equal(await fs.readFile(destinationFilePath, "utf8"), "payload");
        assert.equal(Math.trunc(destinationStats.mtimeMs), sourceTimestamp.getTime());
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile replaces same-sized stale destination files during reconciliation", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const sourceTimestamp = new Date("2026-04-01T10:00:00.000Z");
    const destinationTimestamp = new Date("2026-03-31T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "abc", "utf8");
    await fs.writeFile(destinationFilePath, "xyz", "utf8");
    await fs.utimes(sourceFilePath, sourceTimestamp, sourceTimestamp);
    await fs.utimes(destinationFilePath, destinationTimestamp, destinationTimestamp);

    const runtime = await createRuntime({
        name: "replace-stale-copy",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const sourceStats = await fs.stat(sourceFilePath);
        await syncFile(runtime, sourceFilePath, {
            size: sourceStats.size,
            mtimeMs: sourceStats.mtimeMs
        }, true);

        const destinationStats = await fs.stat(destinationFilePath);
        assert.equal(await fs.readFile(destinationFilePath, "utf8"), "abc");
        assert.equal(Math.trunc(destinationStats.mtimeMs), sourceTimestamp.getTime());
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile skips copying during reconciliation when content matches within the timestamp tolerance", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.writeFile(destinationFilePath, "payload", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);
    await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 10) / 1000);

    const runtime = await createRuntime({
        name: "skip-tolerant-copy",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const destinationBeforeSyncStats = await fs.stat(destinationFilePath);
        const sourceStats = await fs.stat(sourceFilePath);

        await syncFile(runtime, sourceFilePath, {
            size: sourceStats.size,
            mtimeMs: sourceStats.mtimeMs
        }, true);

        const destinationAfterSyncStats = await fs.stat(destinationFilePath);
        assert.equal(await fs.readFile(destinationFilePath, "utf8"), "payload");
        assert.equal(destinationAfterSyncStats.mtimeMs, destinationBeforeSyncStats.mtimeMs);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile treats same-sized destination files within the timestamp tolerance as current during reconciliation even when content differs", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "abc", "utf8");
    await fs.writeFile(destinationFilePath, "xyz", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);
    await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 10) / 1000);

    const runtime = await createRuntime({
        name: "replace-tolerant-stale-copy",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const destinationBeforeSyncStats = await fs.stat(destinationFilePath);
        const sourceStats = await fs.stat(sourceFilePath);

        await syncFile(runtime, sourceFilePath, {
            size: sourceStats.size,
            mtimeMs: sourceStats.mtimeMs
        }, true);

        const destinationAfterSyncStats = await fs.stat(destinationFilePath);
        assert.equal(await fs.readFile(destinationFilePath, "utf8"), "xyz");
        assert.equal(destinationAfterSyncStats.mtimeMs, destinationBeforeSyncStats.mtimeMs);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("handleFileEvent resyncs changed files even when size and mtime stay within the timestamp tolerance", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "abc", "utf8");
    await fs.writeFile(destinationFilePath, "xyz", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);
    await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 10) / 1000);

    const runtime = await createRuntime({
        name: "watch-resync",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await handleFileEvent(runtime, sourceFilePath, "change");

        const destinationStats = await fs.stat(destinationFilePath);
        assert.equal(await fs.readFile(destinationFilePath, "utf8"), "abc");
        assert.equal(Math.trunc(destinationStats.mtimeMs), baseTimestampMs);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("syncFile replaces blocking parent files for nested .app contents", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "Preview.app", "Contents", "Info.plist");
    const blockingDestinationPath = path.join(destinationPath, "Preview.app");

    await fs.ensureDir(path.dirname(sourceFilePath));
    await fs.ensureDir(destinationPath);
    await fs.writeFile(sourceFilePath, "<plist>preview</plist>", "utf8");
    await fs.writeFile(blockingDestinationPath, "blocking-file", "utf8");

    const runtime = await createRuntime({
        name: "replace-blocking-app-parent",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await syncFile(runtime, sourceFilePath);

        assert.equal(await fs.readFile(path.join(destinationPath, "Preview.app", "Contents", "Info.plist"), "utf8"), "<plist>preview</plist>");
        assert.equal((await fs.stat(path.join(destinationPath, "Preview.app"))).isDirectory(), true);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("analyzeRuntime reads destination metadata from the filesystem", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const sourceTimestamp = new Date("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.utimes(sourceFilePath, sourceTimestamp, sourceTimestamp);

    const runtime = await createRuntime({
        name: "filesystem-analysis",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.ensureDir(destinationPath);
        await fs.writeFile(path.join(destinationPath, "keep.txt"), "payload", "utf8");
        await fs.utimes(path.join(destinationPath, "keep.txt"), sourceTimestamp, sourceTimestamp);

        const analysis = await analyzeRuntime(runtime);
        const destinationAnalysis = analysis.destinationAnalyses[0];

        assert.equal(destinationAnalysis.fileCount, 1);
        assert.equal(destinationAnalysis.totalSizeBytes, 7);
        assert.equal(destinationAnalysis.missingFileCount, 0);
        assert.equal(destinationAnalysis.outdatedFileCount, 0);
        assert.equal(destinationAnalysis.extraFileCount, 0);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("analyzeRuntime treats destination files within the timestamp tolerance as current", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);

    const runtime = await createRuntime({
        name: "filesystem-analysis-tolerance",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.ensureDir(destinationPath);
        await fs.writeFile(destinationFilePath, "payload", "utf8");
        await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 10) / 1000);

        const analysis = await analyzeRuntime(runtime);
        const destinationAnalysis = analysis.destinationAnalyses[0];

        assert.equal(destinationAnalysis.outdatedFileCount, 0);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("analyzeRuntime keeps destination files beyond the timestamp tolerance as outdated", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);

    const runtime = await createRuntime({
        name: "filesystem-analysis-outdated",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.ensureDir(destinationPath);
        await fs.writeFile(destinationFilePath, "payload", "utf8");
        await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 11) / 1000);

        const analysis = await analyzeRuntime(runtime);
        const destinationAnalysis = analysis.destinationAnalyses[0];

        assert.equal(destinationAnalysis.outdatedFileCount, 1);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("analyzeRuntime treats same-sized files within the timestamp tolerance as current even when content differs", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "keep.txt");
    const destinationFilePath = path.join(destinationPath, "keep.txt");
    const baseTimestampMs = Date.parse("2026-04-01T10:00:00.000Z");

    await fs.ensureDir(sourcePath);
    await fs.writeFile(sourceFilePath, "abc", "utf8");
    await fs.utimes(sourceFilePath, baseTimestampMs / 1000, baseTimestampMs / 1000);

    const runtime = await createRuntime({
        name: "filesystem-analysis-content-mismatch",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.ensureDir(destinationPath);
        await fs.writeFile(destinationFilePath, "xyz", "utf8");
        await fs.utimes(destinationFilePath, baseTimestampMs / 1000, (baseTimestampMs + 10) / 1000);

        const analysis = await analyzeRuntime(runtime);
        const destinationAnalysis = analysis.destinationAnalyses[0];

        assert.equal(destinationAnalysis.outdatedFileCount, 0);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("runFullSync prunes stale content inside .app directories", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceInfoPlistPath = path.join(sourcePath, "Sample.app", "Contents", "Info.plist");
    const sourceBinaryPath = path.join(sourcePath, "Sample.app", "Contents", "MacOS", "sample");
    const sourceTimestamp = new Date("2026-04-01T10:00:00.000Z");
    const staleDestinationTimestamp = new Date("2026-03-31T10:00:00.000Z");

    await fs.ensureDir(path.dirname(sourceInfoPlistPath));
    await fs.ensureDir(path.dirname(sourceBinaryPath));
    await fs.writeFile(sourceInfoPlistPath, "new-info", "utf8");
    await fs.writeFile(sourceBinaryPath, "binary", "utf8");
    await fs.utimes(sourceInfoPlistPath, sourceTimestamp, sourceTimestamp);

    await fs.ensureDir(path.join(destinationPath, "Sample.app", "Contents", "Resources"));
    await fs.ensureDir(path.join(destinationPath, "Legacy.app", "Contents"));
    await fs.writeFile(path.join(destinationPath, "Sample.app", "Contents", "Info.plist"), "old-info", "utf8");
    await fs.writeFile(path.join(destinationPath, "Sample.app", "Contents", "Resources", "stale.txt"), "stale", "utf8");
    await fs.writeFile(path.join(destinationPath, "Legacy.app", "Contents", "Info.plist"), "legacy", "utf8");
    await fs.utimes(path.join(destinationPath, "Sample.app", "Contents", "Info.plist"), staleDestinationTimestamp, staleDestinationTimestamp);

    const runtime = await createRuntime({
        name: "prune-app-package",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal(await fs.readFile(path.join(destinationPath, "Sample.app", "Contents", "Info.plist"), "utf8"), "new-info");
        assert.equal(await fs.readFile(path.join(destinationPath, "Sample.app", "Contents", "MacOS", "sample"), "utf8"), "binary");
        assert.equal(await fs.pathExists(path.join(destinationPath, "Sample.app", "Contents", "Resources", "stale.txt")), false);
        assert.equal(await fs.pathExists(path.join(destinationPath, "Legacy.app")), false);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("runFullSync preserves empty directories and replaces blocking files", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const emptyDirectoryPath = path.join(sourcePath, "empty");
    const nestedEmptyDirectoryPath = path.join(sourcePath, "nested", "child");

    await fs.ensureDir(emptyDirectoryPath);
    await fs.ensureDir(nestedEmptyDirectoryPath);
    await fs.ensureDir(destinationPath);
    await fs.writeFile(path.join(destinationPath, "empty"), "blocking-file", "utf8");

    const runtime = await createRuntime({
        name: "preserve-empty-directories",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal((await fs.stat(path.join(destinationPath, "empty"))).isDirectory(), true);
        assert.equal((await fs.stat(path.join(destinationPath, "nested", "child"))).isDirectory(), true);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("runFullSync preserves git bootstrap directories re-included by .fmirror-ignore", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(path.join(sourcePath, ".git", "objects"));
    await fs.ensureDir(path.join(sourcePath, ".git", "refs"));
    await fs.writeFile(path.join(sourcePath, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await fs.writeFile(path.join(sourcePath, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
    await fs.writeFile(path.join(sourcePath, ".fmirror-ignore"), [
        "**/.git/**",
        "!**/.git/",
        "!**/.git/HEAD",
        "!**/.git/config",
        "!**/.git/objects/",
        "!**/.git/refs/"
    ].join("\n"), "utf8");

    const runtime = await createRuntime({
        name: "git-bootstrap-directories",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal((await fs.stat(path.join(destinationPath, ".git"))).isDirectory(), true);
        assert.equal((await fs.stat(path.join(destinationPath, ".git", "objects"))).isDirectory(), true);
        assert.equal((await fs.stat(path.join(destinationPath, ".git", "refs"))).isDirectory(), true);
        assert.equal(await fs.readFile(path.join(destinationPath, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
        assert.equal(await fs.readFile(path.join(destinationPath, ".git", "config"), "utf8"), "[core]\n\trepositoryformatversion = 0\n");
    } finally {
        await disposeRuntime(runtime);
    }
});

test("nested ignore files can re-include files in child folders", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(path.join(sourcePath, "logs"));
    await fs.writeFile(path.join(sourcePath, ".fmirror-ignore"), "*.log\n", "utf8");
    await fs.writeFile(path.join(sourcePath, "logs", ".fmirror-ignore"), "!keep.log\n", "utf8");
    await fs.writeFile(path.join(sourcePath, "logs", "keep.log"), "keep", "utf8");
    await fs.writeFile(path.join(sourcePath, "logs", "drop.log"), "drop", "utf8");

    const runtime = await createRuntime({
        name: "nested-ignore",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runFullSync(runtime, "Initial sync");

        assert.equal(await fs.readFile(path.join(destinationPath, "logs", "keep.log"), "utf8"), "keep");
        assert.equal(await fs.pathExists(path.join(destinationPath, "logs", "drop.log")), false);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("queued file events stay persisted until a retry succeeds", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const sourceFilePath = path.join(sourcePath, "nested", "file.txt");
    const mutableFs = fs as typeof fs & {
        copy: typeof fs.copy;
    };
    const originalCopy = fs.copy.bind(fs);
    let shouldFailCopy = true;

    await fs.ensureDir(path.dirname(sourceFilePath));
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.ensureDir(destinationPath);

    const runtime = await createRuntime({
        name: "retry-queue",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    mutableFs.copy = (async (...args: Parameters<typeof fs.copy>) => {
        if (shouldFailCopy) {
            shouldFailCopy = false;
            throw new Error("Simulated copy failure");
        }

        return originalCopy(...args);
    }) as typeof fs.copy;

    try {
        queueFileEvent(runtime, sourceFilePath, "change");

        await waitForCondition(async () => runtime.queuedFileEvents.has(sourceFilePath), 1000);
        await waitForCondition(async () => {
            const queuedEvent = runtime.queuedFileEvents.get(sourceFilePath);
            return Boolean(queuedEvent && queuedEvent.retryTimer);
        }, 2000);

        assert.equal(runtime.queuedFileEvents.has(sourceFilePath), true);

        await waitForCondition(async () => fs.pathExists(path.join(destinationPath, "nested", "file.txt")), 5000);
        assert.equal(await fs.readFile(path.join(destinationPath, "nested", "file.txt"), "utf8"), "payload");
        await waitForCondition(async () => !runtime.queuedFileEvents.has(sourceFilePath), 2000);
    } finally {
        mutableFs.copy = originalCopy;
        await disposeRuntime(runtime);
    }
});

test("analyzeRuntime counts only included files and writes a log", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(sourcePath);
    await fs.writeFile(path.join(sourcePath, "keep-a.txt"), "1234", "utf8");
    await fs.writeFile(path.join(sourcePath, "keep-b.txt"), "123456", "utf8");
    await fs.writeFile(path.join(sourcePath, "skip.tmp"), "123456789", "utf8");
    await fs.writeFile(path.join(sourcePath, ".fmirror-ignore"), "*.tmp\n", "utf8");

    const runtime = await createRuntime({
        name: "analysis",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        const analysis = await analyzeRuntime(runtime);

        assert.equal(analysis.fileCount, 2);
        assert.equal(analysis.totalSizeBytes, 10);
        assert.equal(await fs.pathExists(analysis.logPath), true);

        const logContent = await fs.readFile(analysis.logPath, "utf8");
        assert.match(logContent, /Included files: 2/);
        assert.match(logContent, /Total size bytes: 10/);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("directory move events trigger a reconciliation fallback", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const oldDirectoryPath = path.join(sourcePath, "old");
    const newDirectoryPath = path.join(sourcePath, "new");

    await fs.ensureDir(oldDirectoryPath);
    await fs.writeFile(path.join(oldDirectoryPath, "a.txt"), "payload", "utf8");

    const runtime = await createRuntime({
        name: "rename-dir",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runInitialSync(runtime);
        await fs.writeFile(path.join(destinationPath, "orphan.txt"), "orphan", "utf8");

        await fs.move(oldDirectoryPath, newDirectoryPath);
        await handleDirectoryEvent(runtime, oldDirectoryPath, "unlinkDir", 50);
        await handleDirectoryEvent(runtime, newDirectoryPath, "addDir", 50);

        await waitForCondition(async () => fs.pathExists(path.join(destinationPath, "new", "a.txt")), 8000);
        await waitForCondition(async () => !(await fs.pathExists(path.join(destinationPath, "old"))), 8000);
        await waitForCondition(async () => !(await fs.pathExists(path.join(destinationPath, "orphan.txt"))), 8000);
        assert.equal(await fs.readFile(path.join(destinationPath, "new", "a.txt"), "utf8"), "payload");
    } finally {
        await disposeRuntime(runtime);
    }
});

test("handleDirectoryEvent mirrors empty directory additions immediately", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const addedDirectoryPath = path.join(sourcePath, "empty-added");

    await fs.ensureDir(sourcePath);

    const runtime = await createRuntime({
        name: "mirror-empty-add-dir",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await fs.ensureDir(addedDirectoryPath);
        await handleDirectoryEvent(runtime, addedDirectoryPath, "addDir", 50);

        assert.equal((await fs.stat(path.join(destinationPath, "empty-added"))).isDirectory(), true);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("bulk deletions trigger a full sync fallback", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(sourcePath);

    for (let index = 0; index < 25; index += 1) {
        await fs.writeFile(path.join(sourcePath, `file-${index}.txt`), `payload-${index}`, "utf8");
    }

    const runtime = await createRuntime({
        name: "bulk-delete",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        await runInitialSync(runtime);
        await fs.writeFile(path.join(destinationPath, "orphan.txt"), "orphan", "utf8");

        for (let index = 0; index < 25; index += 1) {
            const sourceFilePath = path.join(sourcePath, `file-${index}.txt`);
            await fs.remove(sourceFilePath);
            queueFileEvent(runtime, sourceFilePath, "unlink", 50);
        }

        await waitForCondition(async () => !(await fs.pathExists(path.join(destinationPath, "orphan.txt"))), 8000);
        await waitForCondition(async () => {
            for (let index = 0; index < 25; index += 1) {
                if (await fs.pathExists(path.join(destinationPath, `file-${index}.txt`))) {
                    return false;
                }
            }

            return true;
        }, 8000);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("createInstallPaths derives config and launch agent paths from the source folder slug", async () => {
    const installPaths = createInstallPaths({
        sourcePath: "/tmp/My Project",
        destinationPath: "/tmp/Backup"
    }, "/Users/test-user");

    assert.equal(createSourceFolderSlug("/tmp/My Project"), "my-project");
    assert.equal(installPaths.globalInstallDirectoryPath, "/Users/test-user/fmirror");
    assert.equal(installPaths.installedBundlePath, "/Users/test-user/fmirror/fmirror.js");
    assert.equal(installPaths.installedExecutablePath, "/Users/test-user/fmirror/fmirror");
    assert.equal(installPaths.installedTemplateDirectoryPath, "/Users/test-user/fmirror/templates");
    assert.equal(installPaths.configPath, "/tmp/My Project/.fmirror/config.json");
    assert.equal(installPaths.ignorePath, "/tmp/My Project/.fmirror-ignore");
    assert.equal(installPaths.launchAgentFileName, "com.fmirror-my-project.plist");
    assert.equal(installPaths.launchAgentPath, "/Users/test-user/Library/LaunchAgents/com.fmirror-my-project.plist");
    assert.equal(installPaths.launchAgentSymlinkPath, "/tmp/My Project/.fmirror/com.fmirror-my-project.plist");
});

test("createInstalledLauncherContent runs the installed bundle main entry point", async () => {
    const launcherContent = createInstalledLauncherContent();

    assert.match(launcherContent, /^#!\/usr\/bin\/env node/m);
    assert.match(launcherContent, /require\("\.\/fmirror\.js"\)/);
    assert.match(launcherContent, /main\(\)\.catch/);
});

test("createPathExportBlock uses the home shortcut for the default install directory", async () => {
    const installDirectoryPath = path.join(os.homedir(), "fmirror");
    const exportBlock = createPathExportBlock(installDirectoryPath);

    assert.match(exportBlock, /\$HOME\/fmirror/);
    assert.match(exportBlock, /export PATH="\$HOME\/fmirror:\$PATH"/);
});

test("renderInstallConfigContent preserves selected existing settings while updating source and destination", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");
    const internalDirectoryPath = path.join(sourcePath, ".fmirror");
    const configPath = path.join(internalDirectoryPath, "config.json");
    const templateContent = `${JSON.stringify({
        debounceMs: 400,
        fileDebounceMs: 1500,
        jobs: [
            {
                name: "template-job",
                source: "/template/source",
                destinations: [
                    "/template/destination"
                ],
                deleteMissing: true,
                watchHidden: true
            }
        ]
    }, null, 4)}\n`;

    await fs.ensureDir(internalDirectoryPath);
    await fs.writeFile(configPath, `${JSON.stringify({
        debounceMs: 900,
        fileDebounceMs: 1200,
        jobs: [
            {
                name: "custom-job",
                source: "/old/source",
                destinations: [
                    "/old/destination"
                ],
                deleteMissing: false,
                watchHidden: false
            }
        ]
    }, null, 4)}\n`, "utf8");

    const renderedConfigContent = await renderInstallConfigContent(templateContent, {
        sourcePath,
        destinationPath
    }, configPath);
    const renderedConfig = JSON.parse(renderedConfigContent);

    assert.equal(renderedConfig.debounceMs, 900);
    assert.equal(renderedConfig.fileDebounceMs, 1200);
    assert.deepEqual(renderedConfig.jobs, [
        {
            name: "custom-job",
            source: sourcePath,
            destinations: [
                destinationPath
            ],
            deleteMissing: false,
            watchHidden: false
        }
    ]);
});

test("renderLaunchAgentTemplate escapes XML-special characters in injected paths", async () => {
    const launchAgentContent = renderLaunchAgentTemplate([
        "<string>{{LABEL}}</string>",
        "<string>{{WORKING_DIRECTORY}}</string>",
        "<string>{{NODE_PATH}}</string>",
        "<string>{{BUNDLE_PATH}}</string>",
        "<string>{{CONFIG_PATH}}</string>",
        "<string>{{STANDARD_OUT_PATH}}</string>",
        "<string>{{STANDARD_ERROR_PATH}}</string>",
        ""
    ].join("\n"), {
        label: "com.fmirror.project&alpha",
        workingDirectoryPath: "/tmp/source&folder",
        nodeExecutablePath: "/opt/node<latest>/bin/node",
        bundlePath: "/tmp/dist/fmirror.js",
        configPath: "/tmp/source/.fmirror/config.json",
        standardOutPath: "/tmp/source/.fmirror/stdout.log",
        standardErrorPath: "/tmp/source/.fmirror/stderr.log"
    });

    assert.match(launchAgentContent, /project&amp;alpha/);
    assert.match(launchAgentContent, /source&amp;folder/);
    assert.match(launchAgentContent, /node&lt;latest&gt;\/bin\/node/);
});

test("setupMirror creates config, preserves existing ignore rules, and registers the macOS launch agent", async () => {
    const tempDirectory = await createTempDirectory();
    const templateDirectoryPath = await createTemplateDirectory(tempDirectory);
    const sourcePath = path.join(tempDirectory, "My Project");
    const destinationPath = path.join(tempDirectory, "Backup");
    const homeDirectoryPath = path.join(tempDirectory, "home");
    const shellProfilePath = path.join(homeDirectoryPath, ".zshrc");
    const bundlePath = path.join(tempDirectory, "dist", "fmirror.js");
    const executedCommands: Array<{ command: string; argumentsList: string[]; ignoreFailure: boolean; }> = [];

    await fs.ensureDir(sourcePath);
    await fs.ensureDir(destinationPath);
    await fs.ensureDir(path.dirname(bundlePath));
    await fs.writeFile(bundlePath, "// bundle placeholder\n", "utf8");
    await fs.writeFile(path.join(sourcePath, ".fmirror-ignore"), "custom-rule/\n", "utf8");

    const installArguments = {
        sourcePath,
        destinationPath
    };
    const installEnvironment = {
        bundlePath,
        templateDirectoryPath,
        nodeExecutablePath: "/usr/local/bin/node",
        homeDirectoryPath,
        platform: "darwin" as NodeJS.Platform,
        shellProfilePath,
        launchdDomainTarget: "gui/501",
        executeCommand: async (command: string, argumentsList: string[], ignoreFailure = false): Promise<void> => {
            executedCommands.push({
                command,
                argumentsList,
                ignoreFailure
            });
        }
    };
    const expectedInstallPaths = createInstallPaths(installArguments, homeDirectoryPath);

    await installGlobalCli(installEnvironment, expectedInstallPaths);
    const installPaths = await setupMirror(installArguments, installEnvironment);

    const installedConfig = await fs.readJson(installPaths.configPath);
    const installedPlistContent = await fs.readFile(installPaths.launchAgentPath, "utf8");
    const installedLauncherContent = await fs.readFile(installPaths.installedExecutablePath, "utf8");
    const installedBundleContent = await fs.readFile(installPaths.installedBundlePath, "utf8");
    const installedTemplateContent = await fs.readFile(path.join(installPaths.installedTemplateDirectoryPath, "config.template.json"), "utf8");
    const shellProfileContent = await fs.readFile(shellProfilePath, "utf8");

    assert.equal(installedConfig.jobs[0].source, sourcePath);
    assert.deepEqual(installedConfig.jobs[0].destinations, [
        destinationPath
    ]);
    assert.equal(await fs.readFile(path.join(sourcePath, ".fmirror-ignore"), "utf8"), "custom-rule/\n");
    assert.equal(installedBundleContent, "// bundle placeholder\n");
    assert.match(installedTemplateContent, /"template-job"/);
    assert.match(installedLauncherContent, /require\("\.\/fmirror\.js"\)/);
    assert.equal(shellProfileContent, createPathExportBlock(installPaths.globalInstallDirectoryPath));
    assert.equal(await fs.pathExists(installPaths.launchAgentPath), true);
    assert.match(installedPlistContent, /com\.fmirror\.my-project/);
    assert.match(installedPlistContent, /\/usr\/local\/bin\/node/);
    assert.match(installedPlistContent, new RegExp(installPaths.installedBundlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(installedPlistContent, /<key>SoftResourceLimits<\/key>/);
    assert.match(installedPlistContent, /<key>HardResourceLimits<\/key>/);
    assert.match(installedPlistContent, /<integer>200000<\/integer>/);
    assert.equal((await fs.lstat(installPaths.launchAgentSymlinkPath)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(installPaths.launchAgentSymlinkPath), await fs.readlink(installPaths.launchAgentSymlinkPath)), installPaths.launchAgentPath);
    assert.deepEqual(executedCommands, [
        {
            command: "launchctl",
            argumentsList: [
                "bootout",
                "gui/501",
                installPaths.launchAgentPath
            ],
            ignoreFailure: true
        },
        {
            command: "launchctl",
            argumentsList: [
                "bootstrap",
                "gui/501",
                installPaths.launchAgentPath
            ],
            ignoreFailure: false
        }
    ]);
});
