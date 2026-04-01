/**
 * fmirror (File Mirror)
 *
 * A small TypeScript/Node.js utility that watches one or more source folders and mirrors them to one or more destination folders.
 *
 * Copyright (c) 2026 Daniele Perilli
 */

import chokidar from "chokidar";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import ignore from "ignore";
import type { CliCommandName, FileEventName, IAppConfig, ICliArguments, IIgnoreFile, IJobConfig, IJobRuntime, IPersistedQueueItem, IPersistedQueueState, IQueuedFileEvent, IRuntimeAnalysis, ISourceManifest } from "./interfaces";

const DEFAULT_CONFIG_FILE_NAME = "fmirror.config.json";
const IGNORE_FILE_NAME = ".fmirrorignore";
const INTERNAL_IGNORE_DIRECTORY_NAME = "_fmirrorignore";
const INTERNAL_APP_DIRECTORY_NAME = "fmirror";
const ERROR_LOG_FILE_NAME = "sync-errors.log";
const ANALYSIS_LOG_FILE_NAME = "source-analysis.log";
const QUEUE_FILE_NAME = "queue.json";
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_FILE_EVENT_DEBOUNCE_MS = 1500;
const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 10000;
const FILE_EVENT_BURST_WINDOW_MS = 1000;
const FILE_EVENT_BURST_THRESHOLD = 20;
const INSTALL_DIRECTORY_NAME = "fmirror";
const INSTALL_EXECUTABLE_FILE_NAME = "fmirror";
const INSTALL_BUNDLE_FILE_NAME = "fmirror.js";
const PATH_EXPORT_BLOCK_START = "# >>> fmirror >>>";
const PATH_EXPORT_BLOCK_END = "# <<< fmirror <<<";

/**
 * Boots the application, loads the config, performs the initial sync, and starts all watchers.
 */
async function main(argv: string[] = process.argv): Promise<void> {
    const cliArguments = parseCliArguments(argv);

    if (cliArguments.command === "install") {
        await installCli(argv);
        return;
    }

    const configPath = getConfigPath(argv);
    const appConfig = await readConfig(configPath);
    const fullSyncDebounceMs = appConfig.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const fileEventDebounceMs = appConfig.fileDebounceMs ?? DEFAULT_FILE_EVENT_DEBOUNCE_MS;
    const runtimes = await Promise.all(appConfig.jobs.map(async (job) => createRuntime(job, fileEventDebounceMs)));

    if (cliArguments.command === "analyze") {
        await analyzeRuntimes(runtimes);
        return;
    }

    if (cliArguments.command === "reconcile") {
        await reconcileRuntimes(runtimes);
        return;
    }

    for (const runtime of runtimes) {
        await runInitialSync(runtime);
        await replayRecoveredQueue(runtime);
        await startWatcher(runtime, fullSyncDebounceMs);
    }

    log(`Watching ${runtimes.length} job(s). Press Ctrl+C to stop.`);
}

/**
 * Parses CLI arguments while keeping backward compatibility with the legacy `fmirror <config>` form.
 *
 * @param argv Raw process arguments.
 */
function parseCliArguments(argv: string[] = process.argv): ICliArguments {
    const firstArgument = argv[2];
    const normalizedCommand = normalizeCliCommandName(firstArgument);

    if (!normalizedCommand) {
        return {
            command: "watch",
            configPath: firstArgument
        };
    }

    return {
        command: normalizedCommand,
        configPath: argv[3]
    };
}

/**
 * Normalizes a CLI command name and resolves supported aliases.
 *
 * @param value CLI token to inspect.
 */
function normalizeCliCommandName(value: string | undefined): CliCommandName | undefined {
    if (value === "watch") {
        return "watch";
    }

    if (value === "analyze" || value === "stats") {
        return "analyze";
    }

    if (value === "reconcile" || value === "sync") {
        return "reconcile";
    }

    if (value === "install") {
        return "install";
    }

    return undefined;
}

/**
 * Resolves the config path from the CLI arguments or falls back to the default config file next to the current app entry point.
 */
function getConfigPath(argv: string[] = process.argv): string {
    const cliArguments = parseCliArguments(argv);
    const fromArgs = cliArguments.configPath;
    if (fromArgs) {
        return path.resolve(fromArgs);
    }

    return getDefaultConfigPath(argv[1]);
}

/**
 * Resolves the default config path located next to the currently executed app file.
 *
 * @param executablePath Path to the current app entry point.
 */
function getDefaultConfigPath(executablePath?: string): string {
    if (!executablePath) {
        return path.resolve(process.cwd(), DEFAULT_CONFIG_FILE_NAME);
    }

    return path.resolve(path.dirname(executablePath), DEFAULT_CONFIG_FILE_NAME);
}

/**
 * Reads and validates the application config file.
 *
 * @param configPath Absolute or relative path to the config file.
 */
async function readConfig(configPath: string): Promise<IAppConfig> {
    const normalizedConfigPath = path.resolve(configPath);

    if (!(await fs.pathExists(normalizedConfigPath))) {
        throw new Error(`Config file not found: ${normalizedConfigPath}`);
    }

    const raw = await fs.readFile(normalizedConfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validateAppConfig(parsed, path.dirname(normalizedConfigPath));
}

/**
 * Validates and normalizes the app config read from disk.
 *
 * @param value Parsed config value.
 * @param configDirectory Absolute directory that contains the config file.
 */
function validateAppConfig(value: unknown, configDirectory: string): IAppConfig {
    if (!isPlainObject(value)) {
        throw new Error("The config file must contain an object.");
    }

    const jobsValue = value.jobs;
    if (!Array.isArray(jobsValue) || jobsValue.length === 0) {
        throw new Error("The config file must contain a non-empty jobs array.");
    }

    const normalizedJobs = jobsValue.map((jobValue, index) => validateJobConfig(jobValue, index, configDirectory));
    assertUniqueJobNames(normalizedJobs);
    assertNoPathOverlaps(normalizedJobs);

    const normalizedConfig: IAppConfig = {
        jobs: normalizedJobs
    };

    if (value.debounceMs !== undefined) {
        normalizedConfig.debounceMs = readNonNegativeInteger(value.debounceMs, "debounceMs");
    }

    if (value.fileDebounceMs !== undefined) {
        normalizedConfig.fileDebounceMs = readNonNegativeInteger(value.fileDebounceMs, "fileDebounceMs");
    }

    return normalizedConfig;
}

/**
 * Validates and normalizes a single job config entry.
 *
 * @param value Parsed job config.
 * @param index Zero-based job index.
 * @param configDirectory Absolute directory that contains the config file.
 */
function validateJobConfig(value: unknown, index: number, configDirectory: string): IJobConfig {
    const fieldPrefix = `jobs[${index}]`;
    if (!isPlainObject(value)) {
        throw new Error(`${fieldPrefix} must be an object.`);
    }

    const name = readNonEmptyString(value.name, `${fieldPrefix}.name`);
    const source = resolveConfiguredPath(readNonEmptyString(value.source, `${fieldPrefix}.source`), configDirectory);
    const deleteMissing = readOptionalBoolean(value.deleteMissing, `${fieldPrefix}.deleteMissing`);
    const watchHidden = readOptionalBoolean(value.watchHidden, `${fieldPrefix}.watchHidden`);

    if (!Array.isArray(value.destinations) || value.destinations.length === 0) {
        throw new Error(`${fieldPrefix}.destinations must be a non-empty array.`);
    }

    const destinations = value.destinations.map((destinationValue, destinationIndex) => {
        const destinationPath = readNonEmptyString(destinationValue, `${fieldPrefix}.destinations[${destinationIndex}]`);
        return resolveConfiguredPath(destinationPath, configDirectory);
    });

    if (new Set(destinations).size !== destinations.length) {
        throw new Error(`${fieldPrefix}.destinations must not contain duplicate paths.`);
    }

    return {
        name,
        source,
        destinations,
        deleteMissing,
        watchHidden
    };
}

/**
 * Ensures every job name is unique.
 *
 * @param jobs Validated jobs from the config.
 */
function assertUniqueJobNames(jobs: IJobConfig[]): void {
    const seenNames = new Set<string>();

    for (const job of jobs) {
        if (seenNames.has(job.name)) {
            throw new Error(`Duplicate job name detected: ${job.name}`);
        }

        seenNames.add(job.name);
    }
}

/**
 * Ensures source and destination paths never overlap across the full config.
 *
 * @param jobs Validated jobs from the config.
 */
function assertNoPathOverlaps(jobs: IJobConfig[]): void {
    const pathEntries = jobs.flatMap((job) => [
        {
            jobName: job.name,
            label: "source",
            absolutePath: normalizeComparablePath(job.source)
        },
        ...job.destinations.map((destinationPath, destinationIndex) => ({
            jobName: job.name,
            label: `destination[${destinationIndex}]`,
            absolutePath: normalizeComparablePath(destinationPath)
        }))
    ]);

    for (let leftIndex = 0; leftIndex < pathEntries.length; leftIndex += 1) {
        const leftEntry = pathEntries[leftIndex];

        for (let rightIndex = leftIndex + 1; rightIndex < pathEntries.length; rightIndex += 1) {
            const rightEntry = pathEntries[rightIndex];

            if (!pathsOverlap(leftEntry.absolutePath, rightEntry.absolutePath)) {
                continue;
            }

            throw new Error(`Path overlap detected between ${leftEntry.jobName} ${leftEntry.label} (${leftEntry.absolutePath}) and ${rightEntry.jobName} ${rightEntry.label} (${rightEntry.absolutePath}).`);
        }
    }
}

/**
 * Normalizes a path for reliable overlap checks.
 *
 * @param inputPath Absolute path to normalize.
 */
function normalizeComparablePath(inputPath: string): string {
    const normalizedPath = path.normalize(path.resolve(inputPath));
    return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

/**
 * Checks whether two absolute paths overlap.
 *
 * @param leftPath First absolute path.
 * @param rightPath Second absolute path.
 */
function pathsOverlap(leftPath: string, rightPath: string): boolean {
    return isSameOrDescendantPath(leftPath, rightPath) || isSameOrDescendantPath(rightPath, leftPath);
}

/**
 * Checks whether a path is the same as or nested inside another path.
 *
 * @param parentPath Candidate parent path.
 * @param childPath Candidate child path.
 */
function isSameOrDescendantPath(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath);
    if (!relativePath) {
        return true;
    }

    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

/**
 * Normalizes a job configuration and prepares its runtime state.
 *
 * @param job Raw job configuration loaded from the config file.
 * @param fileEventDebounceMs Debounce used to coalesce repeated file events on the same path.
 */
async function createRuntime(job: IJobConfig, fileEventDebounceMs: number): Promise<IJobRuntime> {
    const source = path.resolve(job.source);
    const destinations = job.destinations.map((destination) => path.resolve(destination));
    const internalIgnoreDirectory = path.join(source, INTERNAL_IGNORE_DIRECTORY_NAME);
    const internalAppDirectory = path.join(internalIgnoreDirectory, INTERNAL_APP_DIRECTORY_NAME);
    const errorLogPath = path.join(internalAppDirectory, ERROR_LOG_FILE_NAME);
    const queueFilePath = path.join(internalAppDirectory, QUEUE_FILE_NAME);

    if (!(await fs.pathExists(source))) {
        throw new Error(`Source folder does not exist: ${source}`);
    }

    const sourceStats = await fs.stat(source);
    if (!sourceStats.isDirectory()) {
        throw new Error(`Source path must be a directory: ${source}`);
    }

    for (const destination of destinations) {
        if (!(await fs.pathExists(destination))) {
            continue;
        }

        const destinationStats = await fs.stat(destination);
        if (!destinationStats.isDirectory()) {
            throw new Error(`Destination path must be a directory when it already exists: ${destination}`);
        }
    }

    const runtime: IJobRuntime = {
        config: {
            name: job.name,
            source,
            destinations,
            deleteMissing: job.deleteMissing ?? true,
            watchHidden: job.watchHidden ?? true
        },
        ignoreFiles: [],
        internalIgnoreDirectory,
        internalAppDirectory,
        errorLogPath,
        queueFilePath,
        fileEventDebounceMs,
        queuedFileEvents: new Map<string, IQueuedFileEvent>(),
        recoveredQueuePaths: [],
        fileEventBurstCount: 0,
        queuePersistencePromise: Promise.resolve()
    };

    await ensureOperationalStateDirectory(runtime);
    const recoveredQueueItems = await readPersistedQueue(runtime);

    for (const recoveredQueueItem of recoveredQueueItems) {
        runtime.queuedFileEvents.set(recoveredQueueItem.path, {
            eventName: recoveredQueueItem.eventName,
            isProcessing: false,
            runAfterCurrent: false,
            retryCount: 0
        });
        runtime.recoveredQueuePaths.push(recoveredQueueItem.path);
    }

    await persistQueuedFileEvents(runtime);
    await reloadIgnoreFiles(runtime);

    return runtime;
}

/**
 * Reloads every ignore file found inside the source tree for a job runtime.
 *
 * @param runtime Runtime state for the current job.
 */
async function reloadIgnoreFiles(runtime: IJobRuntime): Promise<void> {
    const ignoreFiles: IIgnoreFile[] = [];
    await collectIgnoreFiles(runtime, runtime.config.source, ignoreFiles);
    ignoreFiles.sort((left, right) => left.directory.length - right.directory.length);
    runtime.ignoreFiles = ignoreFiles;
    log(`[${runtime.config.name}] Loaded ${ignoreFiles.length} ${IGNORE_FILE_NAME} file(s).`);
}

/**
 * Recursively discovers ignore files inside the source tree.
 *
 * @param runtime Runtime state for the current job.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param ignoreFiles Mutable list of ignore files collected so far.
 */
async function collectIgnoreFiles(runtime: IJobRuntime, currentDirectory: string, ignoreFiles: IIgnoreFile[]): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);

        if (isOperationalPath(runtime.config.source, absoluteEntryPath)) {
            continue;
        }

        if (entry.isDirectory()) {
            await collectIgnoreFiles(runtime, absoluteEntryPath, ignoreFiles);
            continue;
        }

        if (entry.name !== IGNORE_FILE_NAME) {
            continue;
        }

        const content = await fs.readFile(absoluteEntryPath, "utf8");
        ignoreFiles.push({
            directory: currentDirectory,
            matcher: ignore().add(content)
        });
    }
}

/**
 * Checks whether a path should be excluded from sync according to the loaded ignore rules.
 *
 * @param runtime Runtime state for the current job.
 * @param absolutePath Absolute path to evaluate.
 */
function isIgnored(runtime: IJobRuntime, absolutePath: string): boolean {
    const normalizedPath = path.resolve(absolutePath);

    if (normalizedPath === runtime.config.source) {
        return false;
    }

    const relativeToSource = getRelativePathFromSource(runtime.config.source, normalizedPath);
    if (!relativeToSource || relativeToSource.startsWith("..")) {
        return true;
    }

    if (isOperationalPath(runtime.config.source, normalizedPath)) {
        return true;
    }

    let ignored = false;

    for (const ignoreFile of runtime.ignoreFiles) {
        const relativeToIgnoreDirectory = path.relative(ignoreFile.directory, normalizedPath);
        if (relativeToIgnoreDirectory.startsWith("..") || path.isAbsolute(relativeToIgnoreDirectory)) {
            continue;
        }

        const candidate = toPosix(relativeToIgnoreDirectory);
        if (!candidate) {
            continue;
        }

        const result = testIgnoreMatcher(ignoreFile.matcher, candidate);
        if (result.unignored) {
            ignored = false;
            continue;
        }

        if (result.ignored) {
            ignored = true;
        }
    }

    return ignored;
}

/**
 * Performs the first full file sync for a runtime before the watcher starts processing incremental changes.
 *
 * @param runtime Runtime state for the current job.
 */
async function runInitialSync(runtime: IJobRuntime): Promise<void> {
    await runFullSync(runtime, "Initial sync");
}

/**
 * Performs a full reconciliation of source and destinations for a runtime.
 *
 * @param runtime Runtime state for the current job.
 * @param label Log label describing the sync phase being executed.
 */
async function runFullSync(runtime: IJobRuntime, label: string): Promise<void> {
    log(`[${runtime.config.name}] ${label} started.`);

    try {
        const sourceManifest = await buildSourceManifest(runtime);

        for (const relativeFilePath of Array.from(sourceManifest.files).sort()) {
            const absoluteFilePath = resolveRelativePath(runtime.config.source, relativeFilePath);
            await syncFile(runtime, absoluteFilePath);
        }

        if (runtime.config.deleteMissing) {
            await pruneDestinations(runtime, sourceManifest);
        }
    } catch (error) {
        await appendOperationalErrorLog(runtime, label.toLowerCase(), runtime.config.source, error);
        throw error;
    }

    log(`[${runtime.config.name}] ${label} completed.`);
}

/**
 * Runs a one-shot reconciliation for every configured job and exits.
 *
 * @param runtimes Prepared runtimes for the current config.
 */
async function reconcileRuntimes(runtimes: IJobRuntime[]): Promise<void> {
    for (const runtime of runtimes) {
        await runFullSync(runtime, "Manual reconciliation");
    }

    log(`Reconciled ${runtimes.length} job(s).`);
}

/**
 * Analyzes every source tree excluding ignored files and writes a stats log for each job.
 *
 * @param runtimes Prepared runtimes for the current config.
 */
async function analyzeRuntimes(runtimes: IJobRuntime[]): Promise<void> {
    let totalFileCount = 0;
    let totalSizeBytes = 0;

    for (const runtime of runtimes) {
        const analysis = await analyzeRuntime(runtime);
        totalFileCount += analysis.fileCount;
        totalSizeBytes += analysis.totalSizeBytes;

        log(`[${runtime.config.name}] Analysis completed: ${analysis.fileCount} file(s), ${analysis.totalSizeBytes} bytes (${formatBytes(analysis.totalSizeBytes)}). Log: ${analysis.logPath}`);
    }

    log(`Analysis summary: ${totalFileCount} file(s), ${totalSizeBytes} bytes (${formatBytes(totalSizeBytes)}).`);
}

/**
 * Analyzes a single runtime source tree excluding ignored files and writes the result to the operational log directory.
 *
 * @param runtime Runtime to analyze.
 */
async function analyzeRuntime(runtime: IJobRuntime): Promise<IRuntimeAnalysis> {
    const analysis: IRuntimeAnalysis = {
        fileCount: 0,
        totalSizeBytes: 0,
        logPath: path.join(runtime.internalAppDirectory, ANALYSIS_LOG_FILE_NAME)
    };

    await collectRuntimeAnalysis(runtime, runtime.config.source, analysis);
    await writeRuntimeAnalysisLog(runtime, analysis);
    return analysis;
}

/**
 * Recursively collects included file count and total size for a runtime.
 *
 * @param runtime Runtime to analyze.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param analysis Mutable analysis summary.
 */
async function collectRuntimeAnalysis(runtime: IJobRuntime, currentDirectory: string, analysis: IRuntimeAnalysis): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);

        if (entry.name === IGNORE_FILE_NAME || isOperationalPath(runtime.config.source, absoluteEntryPath)) {
            continue;
        }

        if (!runtime.config.watchHidden && isHiddenName(entry.name)) {
            continue;
        }

        if (entry.isDirectory()) {
            if (isIgnored(runtime, absoluteEntryPath)) {
                continue;
            }

            await collectRuntimeAnalysis(runtime, absoluteEntryPath, analysis);
            continue;
        }

        if (isIgnored(runtime, absoluteEntryPath)) {
            continue;
        }

        const entryStats = await fs.stat(absoluteEntryPath);
        if (!entryStats.isFile()) {
            continue;
        }

        analysis.fileCount += 1;
        analysis.totalSizeBytes += entryStats.size;
    }
}

/**
 * Writes the analysis result for a runtime to a human-readable log file.
 *
 * @param runtime Runtime that was analyzed.
 * @param analysis Computed analysis summary.
 */
async function writeRuntimeAnalysisLog(runtime: IJobRuntime, analysis: IRuntimeAnalysis): Promise<void> {
    const reportLines = [
        `Generated at: ${new Date().toISOString()}`,
        `Job: ${runtime.config.name}`,
        `Source: ${runtime.config.source}`,
        `Destinations: ${runtime.config.destinations.join(", ")}`,
        `Included files: ${analysis.fileCount}`,
        `Total size bytes: ${analysis.totalSizeBytes}`,
        `Total size human: ${formatBytes(analysis.totalSizeBytes)}`
    ];

    await ensureOperationalStateDirectory(runtime);
    await fs.writeFile(analysis.logPath, `${reportLines.join("\n")}\n`, "utf8");
}

/**
 * Installs the built bundle into `~/fmirror` and adds that directory to the user's shell PATH.
 *
 * @param argv Raw process arguments.
 */
async function installCli(argv: string[] = process.argv): Promise<void> {
    const installDirectoryPath = path.join(os.homedir(), INSTALL_DIRECTORY_NAME);
    const sourceBundlePath = await resolveInstallSourceBundlePath(argv);
    const installedBundlePath = path.join(installDirectoryPath, INSTALL_BUNDLE_FILE_NAME);
    const installedExecutablePath = path.join(installDirectoryPath, INSTALL_EXECUTABLE_FILE_NAME);
    const profilePath = await resolveShellProfilePath();

    await fs.ensureDir(installDirectoryPath);
    if (path.resolve(sourceBundlePath) !== path.resolve(installedBundlePath)) {
        await fs.copyFile(sourceBundlePath, installedBundlePath);
    }
    await fs.writeFile(installedExecutablePath, createInstalledLauncherContent(), "utf8");
    await fs.chmod(installedExecutablePath, 0o755);
    await ensurePathExport(profilePath, installDirectoryPath);

    log(`Installed fmirror to ${installDirectoryPath}. Reload your shell or run: source ${profilePath}`);
}

/**
 * Resolves the bundle that should be copied during installation.
 *
 * @param argv Raw process arguments.
 */
async function resolveInstallSourceBundlePath(argv: string[] = process.argv): Promise<string> {
    const localDistBundlePath = path.resolve(process.cwd(), "dist", INSTALL_BUNDLE_FILE_NAME);
    if (await fs.pathExists(localDistBundlePath)) {
        return localDistBundlePath;
    }

    const executablePath = argv[1] ? path.resolve(argv[1]) : undefined;
    if (!executablePath) {
        throw new Error("Built bundle not found. Run npm run build before install.");
    }

    const siblingBundlePath = path.join(path.dirname(executablePath), INSTALL_BUNDLE_FILE_NAME);
    if (await fs.pathExists(siblingBundlePath)) {
        return siblingBundlePath;
    }

    if (path.basename(executablePath) === INSTALL_BUNDLE_FILE_NAME && await fs.pathExists(executablePath)) {
        return executablePath;
    }

    throw new Error("Built bundle not found. Run npm run build before install.");
}

/**
 * Chooses the shell profile file that should receive the PATH export.
 */
async function resolveShellProfilePath(): Promise<string> {
    const shellName = path.basename(process.env.SHELL ?? "");
    const homeDirectoryPath = os.homedir();

    if (shellName === "zsh") {
        return path.join(homeDirectoryPath, ".zshrc");
    }

    if (shellName === "bash") {
        const bashRcPath = path.join(homeDirectoryPath, ".bashrc");
        if (await fs.pathExists(bashRcPath)) {
            return bashRcPath;
        }

        return path.join(homeDirectoryPath, ".bash_profile");
    }

    return path.join(homeDirectoryPath, ".profile");
}

/**
 * Appends the install directory to the selected shell profile when the block is not already present.
 *
 * @param profilePath Shell profile to update.
 * @param installDirectoryPath Directory that should be added to PATH.
 */
async function ensurePathExport(profilePath: string, installDirectoryPath: string): Promise<void> {
    const profileExists = await fs.pathExists(profilePath);
    const currentContent = profileExists ? await fs.readFile(profilePath, "utf8") : "";
    const exportBlock = createPathExportBlock(installDirectoryPath);

    if (currentContent.includes(PATH_EXPORT_BLOCK_START) || currentContent.includes(installDirectoryPath) || currentContent.includes(`$HOME/${INSTALL_DIRECTORY_NAME}`)) {
        return;
    }

    const separator = currentContent && !currentContent.endsWith("\n") ? "\n" : "";
    await fs.writeFile(profilePath, `${currentContent}${separator}${exportBlock}`, "utf8");
}

/**
 * Creates the PATH export block appended to the user's shell profile.
 *
 * @param installDirectoryPath Directory that should be added to PATH.
 */
function createPathExportBlock(installDirectoryPath: string): string {
    const homeInstallDirectoryPath = path.join(os.homedir(), INSTALL_DIRECTORY_NAME);
    const exportDirectoryPath = installDirectoryPath === homeInstallDirectoryPath ? `$HOME/${INSTALL_DIRECTORY_NAME}` : installDirectoryPath;

    return [
        PATH_EXPORT_BLOCK_START,
        `export PATH="${exportDirectoryPath}:$PATH"`,
        PATH_EXPORT_BLOCK_END,
        ""
    ].join("\n");
}

/**
 * Creates the executable launcher script installed into `~/fmirror`.
 */
function createInstalledLauncherContent(): string {
    return [
        "#!/usr/bin/env node",
        "const { main } = require(\"./fmirror.js\");",
        "main().catch((error) => {",
        "    console.error(error instanceof Error ? error.message : String(error));",
        "    process.exitCode = 1;",
        "});",
        ""
    ].join("\n");
}

/**
 * Builds a source manifest containing every mirrored file and directory.
 *
 * @param runtime Runtime state for the current job.
 */
async function buildSourceManifest(runtime: IJobRuntime): Promise<ISourceManifest> {
    const manifest: ISourceManifest = {
        files: new Set<string>(),
        directories: new Set<string>()
    };

    await collectSourceManifest(runtime, runtime.config.source, manifest);
    return manifest;
}

/**
 * Recursively collects mirrored source entries into a manifest.
 *
 * @param runtime Runtime state for the current job.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param manifest Mutable source manifest.
 */
async function collectSourceManifest(runtime: IJobRuntime, currentDirectory: string, manifest: ISourceManifest): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);

        if (entry.name === IGNORE_FILE_NAME || isOperationalPath(runtime.config.source, absoluteEntryPath)) {
            continue;
        }

        if (!runtime.config.watchHidden && isHiddenName(entry.name)) {
            continue;
        }

        if (entry.isDirectory()) {
            if (isIgnored(runtime, absoluteEntryPath)) {
                continue;
            }

            manifest.directories.add(getRelativePathFromSource(runtime.config.source, absoluteEntryPath));
            await collectSourceManifest(runtime, absoluteEntryPath, manifest);
            continue;
        }

        if (isIgnored(runtime, absoluteEntryPath)) {
            continue;
        }

        manifest.files.add(getRelativePathFromSource(runtime.config.source, absoluteEntryPath));
    }
}

/**
 * Removes stale files and directories from every destination so they match the source manifest.
 *
 * @param runtime Runtime state for the current job.
 * @param sourceManifest Mirrored source state computed from the source tree.
 */
async function pruneDestinations(runtime: IJobRuntime, sourceManifest: ISourceManifest): Promise<void> {
    for (const destination of runtime.config.destinations) {
        if (!(await fs.pathExists(destination))) {
            continue;
        }

        await pruneDestination(runtime, destination, sourceManifest);
    }
}

/**
 * Removes stale files and directories from a single destination.
 *
 * @param runtime Runtime state for the current job.
 * @param destination Absolute destination root.
 * @param sourceManifest Mirrored source state computed from the source tree.
 */
async function pruneDestination(runtime: IJobRuntime, destination: string, sourceManifest: ISourceManifest): Promise<void> {
    const destinationManifest = await buildDestinationManifest(destination);

    for (const relativeFilePath of Array.from(destinationManifest.files).sort()) {
        if (sourceManifest.files.has(relativeFilePath)) {
            continue;
        }

        await fs.remove(resolveRelativePath(destination, relativeFilePath));
        log(`[${runtime.config.name}] Deleted stale file ${relativeFilePath}`);
    }

    const directoryPaths = Array.from(destinationManifest.directories).sort((left, right) => right.length - left.length);
    for (const relativeDirectoryPath of directoryPaths) {
        if (sourceManifest.directories.has(relativeDirectoryPath)) {
            continue;
        }

        await fs.remove(resolveRelativePath(destination, relativeDirectoryPath));
        log(`[${runtime.config.name}] Deleted stale directory ${relativeDirectoryPath}`);
    }
}

/**
 * Builds a manifest of the current destination tree.
 *
 * @param destination Absolute destination root to inspect.
 */
async function buildDestinationManifest(destination: string): Promise<ISourceManifest> {
    const manifest: ISourceManifest = {
        files: new Set<string>(),
        directories: new Set<string>()
    };

    await collectDestinationManifest(destination, destination, manifest);
    return manifest;
}

/**
 * Recursively collects destination entries into a manifest.
 *
 * @param destinationRoot Absolute root directory of the destination.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param manifest Mutable destination manifest.
 */
async function collectDestinationManifest(destinationRoot: string, currentDirectory: string, manifest: ISourceManifest): Promise<void> {
    if (!(await fs.pathExists(currentDirectory))) {
        return;
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);
        const relativePath = getRelativePathFromSource(destinationRoot, absoluteEntryPath);

        if (entry.isDirectory()) {
            manifest.directories.add(relativePath);
            await collectDestinationManifest(destinationRoot, absoluteEntryPath, manifest);
            continue;
        }

        manifest.files.add(relativePath);
    }
}

/**
 * Starts the filesystem watcher for a runtime and wires all sync-related event handlers.
 *
 * @param runtime Runtime state for the current job.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 */
async function startWatcher(runtime: IJobRuntime, debounceMs: number): Promise<void> {
    const watcher = chokidar.watch(runtime.config.source, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
        },
        ignored: (watchPath: string) => {
            const absolutePath = path.resolve(watchPath);

            if (path.basename(absolutePath) === IGNORE_FILE_NAME && !isOperationalPath(runtime.config.source, absolutePath)) {
                return false;
            }

            if (!runtime.config.watchHidden && isHiddenPath(runtime.config.source, absolutePath)) {
                return true;
            }

            return isIgnored(runtime, absolutePath);
        }
    });

    runtime.watcher = watcher;

    watcher.on("add", (filePath) => {
        queueFileEvent(runtime, filePath, "add", debounceMs);
    });

    watcher.on("change", (filePath) => {
        queueFileEvent(runtime, filePath, "change", debounceMs);
    });

    watcher.on("unlink", (filePath) => {
        queueFileEvent(runtime, filePath, "unlink", debounceMs);
    });

    watcher.on("addDir", async (dirPath) => {
        await handleDirectoryEvent(runtime, dirPath, "addDir", debounceMs);
    });

    watcher.on("unlinkDir", async (dirPath) => {
        await handleDirectoryEvent(runtime, dirPath, "unlinkDir", debounceMs);
    });

    watcher.on("error", (error) => {
        void appendOperationalErrorLog(runtime, "watcher", runtime.config.source, error);
        log(`[${runtime.config.name}] Watcher error: ${String(error)}`);
    });

    watcher.on("all", (_event, changedPath) => {
        if (path.basename(changedPath) === IGNORE_FILE_NAME && !isOperationalPath(runtime.config.source, changedPath)) {
            log(`[${runtime.config.name}] ${IGNORE_FILE_NAME} changed. Reloading rules.`);
            queueRuntimeFullSync(runtime, debounceMs, "Ignore rules changed.", true);
        }
    });

    await new Promise<void>((resolve) => {
        watcher.once("ready", () => {
            log(`[${runtime.config.name}] Watcher ready.`);
            resolve();
        });
    });
}

/**
 * Replays the queue recovered from disk at startup so pending file events are not lost across restarts.
 *
 * @param runtime Runtime state for the current job.
 */
async function replayRecoveredQueue(runtime: IJobRuntime): Promise<void> {
    if (runtime.recoveredQueuePaths.length === 0) {
        return;
    }

    log(`[${runtime.config.name}] Replaying ${runtime.recoveredQueuePaths.length} queued file event(s) from disk.`);

    for (const recoveredQueuePath of runtime.recoveredQueuePaths) {
        if (!runtime.queuedFileEvents.has(recoveredQueuePath)) {
            continue;
        }

        await flushQueuedFileEvent(runtime, recoveredQueuePath);
    }

    runtime.recoveredQueuePaths = [];
}

/**
 * Queues a file event so repeated changes on the same path are coalesced before sync starts.
 *
 * @param runtime Runtime state for the current job.
 * @param filePath File path received from the watcher.
 * @param eventName File watcher event name.
 * @param fullSyncDebounceMs Debounce used when a burst of file events requires a full reconciliation.
 */
function queueFileEvent(runtime: IJobRuntime, filePath: string, eventName: FileEventName, fullSyncDebounceMs?: number): void {
    const absolutePath = path.resolve(filePath);
    const queuedEvent = runtime.queuedFileEvents.get(absolutePath) ?? {
        eventName,
        isProcessing: false,
        runAfterCurrent: false,
        retryCount: 0
    };

    queuedEvent.eventName = eventName;
    queuedEvent.retryCount = 0;

    if (queuedEvent.debounceTimer) {
        clearTimeout(queuedEvent.debounceTimer);
    }

    if (queuedEvent.retryTimer) {
        clearTimeout(queuedEvent.retryTimer);
        queuedEvent.retryTimer = undefined;
    }

    queuedEvent.debounceTimer = setTimeout(() => {
        queuedEvent.debounceTimer = undefined;
        void flushQueuedFileEvent(runtime, absolutePath);
    }, runtime.fileEventDebounceMs);

    runtime.queuedFileEvents.set(absolutePath, queuedEvent);
    registerFileEventBurst(runtime, fullSyncDebounceMs);
    void persistQueuedFileEvents(runtime);
}

/**
 * Flushes the latest queued file event for a path, ensuring only one sync operation per file runs at a time.
 *
 * @param runtime Runtime state for the current job.
 * @param absolutePath Absolute file path whose queued event should be processed.
 */
async function flushQueuedFileEvent(runtime: IJobRuntime, absolutePath: string): Promise<void> {
    const queuedEvent = runtime.queuedFileEvents.get(absolutePath);

    if (!queuedEvent) {
        return;
    }

    if (queuedEvent.isProcessing) {
        queuedEvent.runAfterCurrent = true;
        return;
    }

    const eventName = queuedEvent.eventName;
    queuedEvent.isProcessing = true;
    queuedEvent.runAfterCurrent = false;
    let wasSuccessful = false;
    let flushError: unknown;

    try {
        await handleFileEvent(runtime, absolutePath, eventName);
        queuedEvent.retryCount = 0;
        wasSuccessful = true;
    } catch (error) {
        queuedEvent.retryCount += 1;
        flushError = error;
    } finally {
        const latestQueuedEvent = runtime.queuedFileEvents.get(absolutePath);

        if (!latestQueuedEvent) {
            return;
        }

        latestQueuedEvent.isProcessing = false;

        if (latestQueuedEvent.debounceTimer) {
            void persistQueuedFileEvents(runtime);
            return;
        }

        if (!wasSuccessful) {
            const retryDelayMs = getRetryDelayMs(latestQueuedEvent.retryCount, runtime.fileEventDebounceMs);
            await appendOperationalErrorLog(runtime, `file ${eventName}`, absolutePath, flushError);
            log(`[${runtime.config.name}] ${eventName} failed for ${absolutePath}: ${formatError(flushError)}. Retrying in ${retryDelayMs}ms.`);

            if (!latestQueuedEvent.retryTimer) {
                latestQueuedEvent.retryTimer = setTimeout(() => {
                    latestQueuedEvent.retryTimer = undefined;
                    void flushQueuedFileEvent(runtime, absolutePath);
                }, retryDelayMs);
            }

            void persistQueuedFileEvents(runtime);
            return;
        }

        if (latestQueuedEvent.runAfterCurrent || latestQueuedEvent.eventName !== eventName) {
            latestQueuedEvent.runAfterCurrent = false;
            void persistQueuedFileEvents(runtime);
            void flushQueuedFileEvent(runtime, absolutePath);
            return;
        }

        runtime.queuedFileEvents.delete(absolutePath);
        void persistQueuedFileEvents(runtime);
    }
}

/**
 * Handles file-level watcher events and propagates the corresponding sync or deletion to all destinations.
 *
 * @param runtime Runtime state for the current job.
 * @param filePath File path received from the watcher.
 * @param eventName File watcher event name.
 */
async function handleFileEvent(runtime: IJobRuntime, filePath: string, eventName: FileEventName): Promise<void> {
    const absolutePath = path.resolve(filePath);

    if (!isPathInsideSource(runtime.config.source, absolutePath)) {
        return;
    }

    if (path.basename(absolutePath) === IGNORE_FILE_NAME || isOperationalPath(runtime.config.source, absolutePath)) {
        return;
    }

    if (!runtime.config.watchHidden && isHiddenPath(runtime.config.source, absolutePath)) {
        return;
    }

    if (eventName !== "unlink" && isIgnored(runtime, absolutePath)) {
        return;
    }

    if (eventName === "unlink") {
        if (runtime.config.deleteMissing) {
            await deleteFileFromDestinations(runtime, absolutePath);
        }
        return;
    }

    if (!(await fs.pathExists(absolutePath))) {
        if (runtime.config.deleteMissing) {
            await deleteFileFromDestinations(runtime, absolutePath);
        }
        return;
    }

    await syncFile(runtime, absolutePath);
}

/**
 * Handles directory-level watcher events and removes mirrored directories when configured to do so.
 *
 * @param runtime Runtime state for the current job.
 * @param dirPath Directory path received from the watcher.
 * @param eventName Directory watcher event name.
 * @param fullSyncDebounceMs Debounce used when structural changes require a full reconciliation.
 */
async function handleDirectoryEvent(runtime: IJobRuntime, dirPath: string, eventName: "addDir" | "unlinkDir", fullSyncDebounceMs?: number): Promise<void> {
    const absolutePath = path.resolve(dirPath);

    if (!isPathInsideSource(runtime.config.source, absolutePath)) {
        return;
    }

    if (path.basename(absolutePath) === IGNORE_FILE_NAME || isOperationalPath(runtime.config.source, absolutePath)) {
        return;
    }

    if (!runtime.config.watchHidden && isHiddenPath(runtime.config.source, absolutePath)) {
        return;
    }

    try {
        if (eventName === "unlinkDir" && runtime.config.deleteMissing) {
            await deleteDirectoryFromDestinations(runtime, absolutePath);
        }

        if (fullSyncDebounceMs !== undefined) {
            queueRuntimeFullSync(runtime, fullSyncDebounceMs, `Structural change detected (${eventName}).`);
        }
    } catch (error) {
        await appendOperationalErrorLog(runtime, `directory ${eventName}`, absolutePath, error);
        log(`[${runtime.config.name}] ${eventName} failed for ${absolutePath}: ${formatError(error)}`);
    }
}

/**
 * Copies a source file to every configured destination while preserving timestamps.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteFilePath Absolute path of the source file to sync.
 */
async function syncFile(runtime: IJobRuntime, absoluteFilePath: string): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absoluteFilePath);

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        await fs.ensureDir(path.dirname(destinationPath));
        await fs.copy(absoluteFilePath, destinationPath, {
            overwrite: true,
            preserveTimestamps: true,
            errorOnExist: false
        });
    }

    log(`[${runtime.config.name}] Synced ${relativePath}`);
}

/**
 * Removes a mirrored file from every configured destination.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteFilePath Absolute path of the source file that was removed.
 */
async function deleteFileFromDestinations(runtime: IJobRuntime, absoluteFilePath: string): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absoluteFilePath);

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        await fs.remove(destinationPath);
    }

    log(`[${runtime.config.name}] Deleted file ${relativePath}`);
}

/**
 * Removes a mirrored directory from every configured destination.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteDirectoryPath Absolute path of the source directory that was removed.
 */
async function deleteDirectoryFromDestinations(runtime: IJobRuntime, absoluteDirectoryPath: string): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absoluteDirectoryPath);

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        await fs.remove(destinationPath);
    }

    log(`[${runtime.config.name}] Deleted directory ${relativePath}`);
}

/**
 * Ensures that the reserved operational directory and its files exist inside the source root.
 *
 * @param runtime Runtime state for the current job.
 */
async function ensureOperationalStateDirectory(runtime: IJobRuntime): Promise<void> {
    await fs.ensureDir(runtime.internalIgnoreDirectory);
    await fs.ensureDir(runtime.internalAppDirectory);
    await fs.ensureFile(runtime.errorLogPath);
}

/**
 * Appends a sync-related error entry to the operational log stored inside the reserved source directory.
 *
 * @param runtime Runtime state for the current job.
 * @param scope Short label describing the failing sync operation.
 * @param targetPath Source path associated with the error.
 * @param error Error value thrown by the runtime.
 */
async function appendOperationalErrorLog(runtime: IJobRuntime, scope: string, targetPath: string, error: unknown): Promise<void> {
    const entry = `${new Date().toISOString()} [${runtime.config.name}] ${scope} ${targetPath}: ${formatError(error)}\n`;

    try {
        await ensureOperationalStateDirectory(runtime);
        await fs.appendFile(runtime.errorLogPath, entry, "utf8");
    } catch (writeError) {
        console.error(`${new Date().toISOString()} [${runtime.config.name}] Failed to write ${runtime.errorLogPath}: ${formatError(writeError)}`);
    }
}

/**
 * Reads the persisted queue file from disk and keeps only valid file events that belong to the current source tree.
 *
 * @param runtime Runtime state for the current job.
 */
async function readPersistedQueue(runtime: IJobRuntime): Promise<IPersistedQueueItem[]> {
    if (!(await fs.pathExists(runtime.queueFilePath))) {
        return [];
    }

    try {
        const rawQueue = await fs.readFile(runtime.queueFilePath, "utf8");

        if (!rawQueue.trim()) {
            return [];
        }

        const parsedQueue = JSON.parse(rawQueue) as Partial<IPersistedQueueState>;
        if (!Array.isArray(parsedQueue.items)) {
            return [];
        }

        const normalizedItems = new Map<string, IPersistedQueueItem>();

        for (const parsedItem of parsedQueue.items) {
            const normalizedItem = normalizePersistedQueueItem(runtime, parsedItem);
            if (!normalizedItem) {
                continue;
            }

            normalizedItems.set(normalizedItem.path, normalizedItem);
        }

        return Array.from(normalizedItems.values());
    } catch (error) {
        await appendOperationalErrorLog(runtime, "queue restore", runtime.queueFilePath, error);
        return [];
    }
}

/**
 * Persists the in-memory queue to disk so pending file events survive process restarts.
 *
 * @param runtime Runtime state for the current job.
 */
async function persistQueuedFileEvents(runtime: IJobRuntime): Promise<void> {
    runtime.queuePersistencePromise = runtime.queuePersistencePromise
        .catch(() => undefined)
        .then(async () => {
            const persistedQueueState: IPersistedQueueState = {
                version: 1,
                updatedAt: new Date().toISOString(),
                items: Array.from(runtime.queuedFileEvents.entries()).map(([queuedPath, queuedEvent]) => ({
                    path: queuedPath,
                    eventName: queuedEvent.eventName
                }))
            };
            const tempQueueFilePath = `${runtime.queueFilePath}.tmp`;

            await ensureOperationalStateDirectory(runtime);
            await fs.writeFile(tempQueueFilePath, `${JSON.stringify(persistedQueueState, null, 4)}\n`, "utf8");
            await fs.move(tempQueueFilePath, runtime.queueFilePath, { overwrite: true });
        })
        .catch(async (error) => {
            await appendOperationalErrorLog(runtime, "queue persist", runtime.queueFilePath, error);
        });

    await runtime.queuePersistencePromise;
}

/**
 * Validates a queue item loaded from disk and normalizes it to an absolute source path.
 *
 * @param runtime Runtime state for the current job.
 * @param parsedItem Queue item parsed from the persisted queue file.
 */
function normalizePersistedQueueItem(runtime: IJobRuntime, parsedItem: unknown): IPersistedQueueItem | undefined {
    if (!isPersistedQueueItem(parsedItem)) {
        return undefined;
    }

    const normalizedPath = path.resolve(parsedItem.path);
    if (!isPathInsideSource(runtime.config.source, normalizedPath)) {
        return undefined;
    }

    if (isOperationalPath(runtime.config.source, normalizedPath)) {
        return undefined;
    }

    return {
        path: normalizedPath,
        eventName: parsedItem.eventName
    };
}

/**
 * Resolves a config path relative to the config file directory.
 *
 * @param inputPath Path value from the config file.
 * @param configDirectory Absolute directory that contains the config file.
 */
function resolveConfiguredPath(inputPath: string, configDirectory: string): string {
    if (inputPath === "~") {
        return os.homedir();
    }

    if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
        return path.join(os.homedir(), inputPath.slice(2));
    }

    if (path.isAbsolute(inputPath)) {
        return path.resolve(inputPath);
    }

    return path.resolve(configDirectory, inputPath);
}

/**
 * Converts a path to POSIX separators for ignore pattern matching.
 *
 * @param inputPath Path to normalize.
 */
function toPosix(inputPath: string): string {
    return inputPath.split(path.sep).join("/");
}

/**
 * Returns the source-relative path of an entry using POSIX separators.
 *
 * @param sourcePath Absolute source root for the current job.
 * @param absolutePath Absolute path to normalize.
 */
function getRelativePathFromSource(sourcePath: string, absolutePath: string): string {
    return toPosix(path.relative(sourcePath, path.resolve(absolutePath)));
}

/**
 * Resolves a POSIX relative path under a destination or source root.
 *
 * @param rootPath Absolute root path.
 * @param relativePath POSIX relative path.
 */
function resolveRelativePath(rootPath: string, relativePath: string): string {
    return path.join(rootPath, ...relativePath.split("/"));
}

/**
 * Checks whether a path is a real descendant of the current source root.
 *
 * @param sourcePath Absolute source root for the current job.
 * @param absolutePath Absolute path to evaluate.
 */
function isPathInsideSource(sourcePath: string, absolutePath: string): boolean {
    const relativeToSource = toPosix(path.relative(sourcePath, path.resolve(absolutePath)));

    if (!relativeToSource || relativeToSource.startsWith("..")) {
        return false;
    }

    return !path.isAbsolute(relativeToSource);
}

/**
 * Checks whether a path is hidden somewhere inside the source tree.
 *
 * @param sourcePath Absolute source root for the current job.
 * @param absolutePath Absolute path to evaluate.
 */
function isHiddenPath(sourcePath: string, absolutePath: string): boolean {
    const relativeToSource = getRelativePathFromSource(sourcePath, absolutePath);
    if (!relativeToSource || relativeToSource.startsWith("..")) {
        return false;
    }

    return relativeToSource.split("/").some(isHiddenName);
}

/**
 * Checks whether a single path segment should be considered hidden.
 *
 * @param name Path segment name.
 */
function isHiddenName(name: string): boolean {
    return name.startsWith(".") && name !== "." && name !== "..";
}

/**
 * Checks whether a path belongs to the reserved operational directory that must never be mirrored.
 *
 * @param sourcePath Absolute source root for the current job.
 * @param absolutePath Absolute path to evaluate.
 */
function isOperationalPath(sourcePath: string, absolutePath: string): boolean {
    const relativeToSource = toPosix(path.relative(sourcePath, path.resolve(absolutePath)));

    if (!relativeToSource || relativeToSource.startsWith("..")) {
        return false;
    }

    return relativeToSource.split("/").includes(INTERNAL_IGNORE_DIRECTORY_NAME);
}

/**
 * Executes an ignore matcher against both file and directory candidates.
 *
 * @param matcher Ignore matcher instance.
 * @param candidate Source-relative candidate path.
 */
function testIgnoreMatcher(matcher: ReturnType<typeof ignore>, candidate: string): { ignored: boolean; unignored: boolean } {
    const directResult = matcher.test(candidate);
    if (directResult.ignored || directResult.unignored || candidate.endsWith("/")) {
        return {
            ignored: directResult.ignored,
            unignored: directResult.unignored
        };
    }

    const directoryResult = matcher.test(`${candidate}/`);
    return {
        ignored: directoryResult.ignored,
        unignored: directoryResult.unignored
    };
}

/**
 * Checks whether a parsed value matches the persisted queue item shape expected by the app.
 *
 * @param value Parsed value to validate.
 */
function isPersistedQueueItem(value: unknown): value is IPersistedQueueItem {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Partial<IPersistedQueueItem>;
    return typeof candidate.path === "string" && isFileEventName(candidate.eventName);
}

/**
 * Checks whether a string is a valid file event name supported by the queue.
 *
 * @param value String value to validate.
 */
function isFileEventName(value: unknown): value is FileEventName {
    return value === "add" || value === "change" || value === "unlink";
}

/**
 * Checks whether a parsed value is a plain object.
 *
 * @param value Parsed value to validate.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a required non-empty string field from an object.
 *
 * @param value Parsed field value.
 * @param fieldName Fully qualified field name for error messages.
 */
function readNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${fieldName} must be a non-empty string.`);
    }

    return value.trim();
}

/**
 * Reads an optional boolean field from an object.
 *
 * @param value Parsed field value.
 * @param fieldName Fully qualified field name for error messages.
 */
function readOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "boolean") {
        throw new Error(`${fieldName} must be a boolean when provided.`);
    }

    return value;
}

/**
 * Reads a non-negative integer field from an object.
 *
 * @param value Parsed field value.
 * @param fieldName Fully qualified field name for error messages.
 */
function readNonNegativeInteger(value: unknown, fieldName: string): number {
    if (!Number.isInteger(value) || Number(value) < 0) {
        throw new Error(`${fieldName} must be a non-negative integer.`);
    }

    return Number(value);
}

/**
 * Computes the retry delay used for failed queued file events.
 *
 * @param retryCount Number of consecutive failures for the same event.
 * @param debounceMs Configured debounce used for file events.
 */
function getRetryDelayMs(retryCount: number, debounceMs: number): number {
    const baseDelayMs = Math.max(MIN_RETRY_DELAY_MS, debounceMs);
    return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * Math.max(1, retryCount));
}

/**
 * Tracks bursts of file activity and schedules a reconciliation when too many incremental events happen in a short time.
 *
 * @param runtime Runtime state for the current job.
 * @param fullSyncDebounceMs Debounce used when a burst requires a full reconciliation.
 */
function registerFileEventBurst(runtime: IJobRuntime, fullSyncDebounceMs?: number): void {
    if (fullSyncDebounceMs === undefined) {
        return;
    }

    runtime.fileEventBurstCount += 1;

    if (runtime.fileEventBurstTimer) {
        clearTimeout(runtime.fileEventBurstTimer);
    }

    runtime.fileEventBurstTimer = setTimeout(() => {
        runtime.fileEventBurstCount = 0;
        runtime.fileEventBurstTimer = undefined;
    }, FILE_EVENT_BURST_WINDOW_MS);

    if (runtime.fileEventBurstCount < FILE_EVENT_BURST_THRESHOLD) {
        return;
    }

    clearTimeout(runtime.fileEventBurstTimer);
    runtime.fileEventBurstTimer = undefined;
    runtime.fileEventBurstCount = 0;
    queueRuntimeFullSync(runtime, fullSyncDebounceMs, `High file event volume detected (>= ${FILE_EVENT_BURST_THRESHOLD}).`);
}

/**
 * Debounces a full reconciliation for scenarios where incremental events are not reliable enough to represent the final tree state.
 *
 * @param runtime Runtime state for the current job.
 * @param debounceMs Delay used to debounce the reconciliation.
 * @param reason Human-readable reason for logging.
 * @param shouldReloadIgnoreFiles Whether ignore files should be reloaded before reconciling.
 */
function queueRuntimeFullSync(runtime: IJobRuntime, debounceMs: number, reason: string, shouldReloadIgnoreFiles = false): void {
    if (runtime.fullSyncTimer) {
        clearTimeout(runtime.fullSyncTimer);
    }

    runtime.fullSyncTimer = setTimeout(async () => {
        try {
            if (shouldReloadIgnoreFiles) {
                await reloadIgnoreFiles(runtime);
            }

            log(`[${runtime.config.name}] ${reason} Running reconciliation.`);
            await runFullSync(runtime, "Full sync");
        } catch (error) {
            await appendOperationalErrorLog(runtime, "full sync", runtime.config.source, error);
            log(`[${runtime.config.name}] Full sync failed: ${formatError(error)}`);
        }
    }, debounceMs);
}

/**
 * Formats a byte size using binary units for easier human comparison.
 *
 * @param sizeBytes Raw size in bytes.
 */
function formatBytes(sizeBytes: number): string {
    if (sizeBytes < 1024) {
        return `${sizeBytes} B`;
    }

    const units = [
        "KiB",
        "MiB",
        "GiB",
        "TiB"
    ];
    let value = sizeBytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Writes a timestamped log entry to stdout.
 *
 * @param message Message to print.
 */
function log(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} ${message}`);
}

/**
 * Normalizes unknown errors into a readable log message.
 *
 * @param error Error value thrown by the runtime.
 */
function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

const isDirectExecution = typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isDirectExecution) {
    main().catch((error) => {
        console.error(formatError(error));
        process.exitCode = 1;
    });
}

export { analyzeRuntime, appendOperationalErrorLog, createInstalledLauncherContent, createPathExportBlock, createRuntime, flushQueuedFileEvent, getConfigPath, getRetryDelayMs, handleDirectoryEvent, handleFileEvent, isHiddenPath, isIgnored, isPathInsideSource, main, parseCliArguments, queueFileEvent, readConfig, reconcileRuntimes, reloadIgnoreFiles, resolveConfiguredPath, runFullSync, runInitialSync, startWatcher, syncFile };
