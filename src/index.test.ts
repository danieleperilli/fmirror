import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "fs-extra";
import type { IJobRuntime } from "./interfaces";
import { analyzeRuntime, createInstalledLauncherContent, createPathExportBlock, createRuntime, getConfigPath, handleDirectoryEvent, parseCliArguments, queueFileEvent, readConfig, runFullSync, runInitialSync } from "./index";

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
        configPath: "./custom.config.json"
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
        configPath: "./custom.config.json"
    });

    assert.deepEqual(parseCliArguments([
        "node",
        "/tmp/dist/fmirror.js",
        "stats",
        "./custom.config.json"
    ]), {
        command: "analyze",
        configPath: "./custom.config.json"
    });
});

/**
 * Creates and returns a temporary directory for a test case.
 */
async function createTempDirectory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "fmirror-"));
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

test("runFullSync removes stale and ignored destination entries", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(path.join(sourcePath, "docs"));
    await fs.writeFile(path.join(sourcePath, "docs", "readme.txt"), "docs", "utf8");
    await fs.writeFile(path.join(sourcePath, "keep.txt"), "keep", "utf8");
    await fs.writeFile(path.join(sourcePath, "ignored.txt"), "ignored", "utf8");
    await fs.writeFile(path.join(sourcePath, ".fmirrorignore"), "ignored.txt\nlegacy/\n", "utf8");

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
        assert.equal(await fs.pathExists(path.join(destinationPath, ".fmirrorignore")), false);
    } finally {
        await disposeRuntime(runtime);
    }
});

test("nested ignore files can re-include files in child folders", async () => {
    const tempDirectory = await createTempDirectory();
    const sourcePath = path.join(tempDirectory, "source");
    const destinationPath = path.join(tempDirectory, "destination");

    await fs.ensureDir(path.join(sourcePath, "logs"));
    await fs.writeFile(path.join(sourcePath, ".fmirrorignore"), "*.log\n", "utf8");
    await fs.writeFile(path.join(sourcePath, "logs", ".fmirrorignore"), "!keep.log\n", "utf8");
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
    const blockingPath = path.join(destinationPath, "nested");

    await fs.ensureDir(path.dirname(sourceFilePath));
    await fs.writeFile(sourceFilePath, "payload", "utf8");
    await fs.ensureDir(destinationPath);
    await fs.writeFile(blockingPath, "blocking-file", "utf8");

    const runtime = await createRuntime({
        name: "retry-queue",
        source: sourcePath,
        destinations: [
            destinationPath
        ],
        deleteMissing: true,
        watchHidden: true
    }, 25);

    try {
        queueFileEvent(runtime, sourceFilePath, "change");

        await waitForCondition(async () => runtime.queuedFileEvents.has(sourceFilePath), 1000);
        await waitForCondition(async () => {
            const queuedEvent = runtime.queuedFileEvents.get(sourceFilePath);
            return Boolean(queuedEvent && queuedEvent.retryTimer);
        }, 2000);

        assert.equal(runtime.queuedFileEvents.has(sourceFilePath), true);

        await fs.remove(blockingPath);

        await waitForCondition(async () => fs.pathExists(path.join(destinationPath, "nested", "file.txt")), 5000);
        assert.equal(await fs.readFile(path.join(destinationPath, "nested", "file.txt"), "utf8"), "payload");
        await waitForCondition(async () => !runtime.queuedFileEvents.has(sourceFilePath), 2000);
    } finally {
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
    await fs.writeFile(path.join(sourcePath, ".fmirrorignore"), "*.tmp\n", "utf8");

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

test("createInstalledLauncherContent runs the local bundle main entry point", async () => {
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
