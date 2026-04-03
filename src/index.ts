/**
 * fmirror (File Mirror)
 *
 * A small TypeScript/Node.js utility that watches one or more source folders and mirrors them to one or more destination folders.
 *
 * Copyright (c) 2026 Daniele Perilli
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import ignore from "ignore";
import type { CliCommandName, FileEventName, IAppConfig, ICliArguments, IDestinationAnalysis, IFileState, IIgnoreFile, IJobConfig, IJobRuntime, IPersistedQueueItem, IPersistedQueueState, IQueuedFileEvent, IRuntimeAnalysis, IWatchSession } from "./interfaces";

const DEFAULT_CONFIG_FILE_NAME = "fmirror.config.json";
const IGNORE_FILE_NAME = ".fmirror-ignore";
const INTERNAL_APP_DIRECTORY_NAME = ".fmirror";
const ERROR_LOG_FILE_NAME = "sync-error.log";
const ANALYSIS_LOG_FILE_NAME = "source-analysis.log";
const QUEUE_FILE_NAME = "queue.json";
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_FILE_EVENT_DEBOUNCE_MS = 1500;
const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 10000;
const FILE_EVENT_BURST_WINDOW_MS = 1000;
const FILE_EVENT_BURST_THRESHOLD = 20;
const WATCHER_ERROR_LOG_WINDOW_MS = 30000;
const WATCHER_LIMIT_ERROR_LOG_WINDOW_MS = 300000;
const FILE_STATE_MTIME_TOLERANCE_MS = 10;
const MAX_MANAGED_STDOUT_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const RETAINED_MANAGED_STDOUT_LOG_SIZE_BYTES = 2 * 1024 * 1024;
const MANAGED_STDOUT_LOG_MAINTENANCE_WINDOW_MS = 1000;
const INSTALL_DIRECTORY_NAME = "fmirror";
const INSTALL_EXECUTABLE_FILE_NAME = "fmirror";
const INSTALL_BUNDLE_FILE_NAME = "fmirror.js";
const INSTALL_CONFIG_FILE_NAME = "config.json";
const LAUNCH_AGENT_DIRECTORY_NAME = "LaunchAgents";
const LAUNCH_AGENT_LOG_FILE_NAME = "launchd.log";
const LAUNCH_AGENT_ERROR_LOG_FILE_NAME = "launchd-error.log";
const TEMPLATE_DIRECTORY_NAME = "templates";
const CONFIG_TEMPLATE_FILE_NAME = "config.template.json";
const IGNORE_TEMPLATE_FILE_NAME = "fmirror-ignore.template";
const LAUNCH_AGENT_TEMPLATE_FILE_NAME = "launch-agent.template.plist";
const PATH_EXPORT_BLOCK_START = "# >>> fmirror >>>";
const PATH_EXPORT_BLOCK_END = "# <<< fmirror <<<";
const WATCHMAN_SUBSCRIPTION_NAME_PREFIX = "fmirror-";
const WATCHMAN_SUBSCRIBE_TIMEOUT_MS = 10000;
const WATCHMAN_BINARY_ENV_NAME = "FMIRROR_WATCHMAN_PATH";
const WATCHMAN_COMMAND_ARGUMENTS = [
    "-j",
    "--server-encoding=json",
    "--output-encoding=json",
    "--no-pretty"
];

const execFileAsync = promisify(execFile);
let cachedWatchmanExecutablePath: string | undefined;
const managedStdoutLogPaths = new Set<string>();
let managedStdoutLogMaintenancePromise: Promise<void> = Promise.resolve();
let lastManagedStdoutLogMaintenanceAtMs = 0;

interface ISourceFileVisit {
    absolutePath: string;
    relativePath: string;
    fileState: IFileState;
}

interface IRunFullSyncOptions {
    shouldLogSyncedEntries?: boolean;
}

type SourceEntryType = "file" | "directory";

interface IInstallArguments {
    sourcePath: string;
    destinationPath: string;
}

interface IInstallEnvironment {
    bundlePath: string;
    templateDirectoryPath: string;
    nodeExecutablePath: string;
    homeDirectoryPath: string;
    platform: NodeJS.Platform;
    shellProfilePath?: string;
    launchdDomainTarget?: string;
    executeCommand(command: string, argumentsList: string[], ignoreFailure?: boolean): Promise<void>;
}

interface IGlobalInstallPaths {
    globalInstallDirectoryPath: string;
    installedBundlePath: string;
    installedExecutablePath: string;
    installedTemplateDirectoryPath: string;
}

interface IInstallPaths extends IGlobalInstallPaths {
    sourceFolderSlug: string;
    internalAppDirectoryPath: string;
    configPath: string;
    ignorePath: string;
    launchAgentLabel: string;
    launchAgentFileName: string;
    launchAgentPath: string;
    launchAgentSymlinkPath: string;
    launchAgentLogPath: string;
    launchAgentErrorLogPath: string;
}

interface IWatchmanWatchProjectResponse {
    error?: string;
    warning?: string;
    watch: string;
    relative_path?: string;
}

interface IWatchmanClockResponse {
    error?: string;
    warning?: string;
    clock: string;
}

interface IWatchmanSubscribeResponse {
    error?: string;
    warning?: string;
    subscribe: string;
}

interface IWatchmanSubscriptionFile {
    name: string;
    exists?: boolean;
    type?: string;
}

interface IWatchmanSubscriptionNotification {
    error?: string;
    warning?: string;
    subscription?: string;
    is_fresh_instance?: boolean;
    files?: IWatchmanSubscriptionFile[];
}

interface IWatchmanSubscriptionOptions {
    fields: string[];
    since: string;
    relative_root?: string;
}

interface IWatchmanSession extends IWatchSession {
    process: ChildProcessWithoutNullStreams;
    subscriptionName: string;
    isClosing: boolean;
}

/**
 * Boots the application, loads the config, performs the initial sync, and starts all watchers.
 */
async function main(argv: string[] = process.argv): Promise<void> {
    const cliArguments = parseCliArguments(argv);

    if (cliArguments.command === "install") {
        await installCli(argv);
        return;
    }

    if (cliArguments.command === "setup") {
        await setupCli(argv);
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

    let activeWatcherCount = 0;

    for (const runtime of runtimes) {
        if (cliArguments.fastStart) {
            log(`Fast start enabled. Skipping initial sync.`);
        } else {
            await runInitialSync(runtime);
        }

        await replayRecoveredQueue(runtime);
        if (await startWatcher(runtime, fullSyncDebounceMs)) {
            activeWatcherCount += 1;
        }
    }

    log(`Watching ${activeWatcherCount} of ${runtimes.length} job(s). Press Ctrl+C to stop.`);
}

/**
 * Parses CLI arguments while keeping backward compatibility with the legacy `fmirror <config>` form.
 *
 * @param argv Raw process arguments.
 */
function parseCliArguments(argv: string[] = process.argv): ICliArguments {
    const rawArguments = argv.slice(2);
    const normalizedCommand = normalizeCliCommandName(rawArguments[0]);
    const command = normalizedCommand ?? "watch";
    const remainingArguments = normalizedCommand ? rawArguments.slice(1) : rawArguments;
    let configPath: string | undefined;
    let fastStart = false;

    for (const argument of remainingArguments) {
        if (isFastStartFlag(argument)) {
            fastStart = true;
            continue;
        }

        if (!configPath) {
            configPath = argument;
        }
    }

    return {
        command,
        configPath,
        fastStart
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

    if (value === "setup") {
        return "setup";
    }

    return undefined;
}

/**
 * Checks whether a CLI token enables fast start mode, which skips the initial full reconciliation.
 *
 * @param value CLI token to inspect.
 */
function isFastStartFlag(value: string | undefined): boolean {
    return value === "-fast-start" || value === "--fast-start";
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
        return validateDestinationConfig(destinationValue, `${fieldPrefix}.destinations[${destinationIndex}]`, configDirectory);
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
 * Validates and normalizes a single destination path.
 *
 * @param value Parsed destination path.
 * @param fieldName Fully qualified destination field name.
 * @param configDirectory Absolute directory that contains the config file.
 */
function validateDestinationConfig(value: unknown, fieldName: string, configDirectory: string): string {
    return resolveConfiguredPath(readNonEmptyString(value, fieldName), configDirectory);
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
        ...job.destinations.map((destinationConfig, destinationIndex) => ({
            jobName: job.name,
            label: `destination[${destinationIndex}]`,
            absolutePath: normalizeComparablePath(destinationConfig)
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
    const destinations = job.destinations.map((destinationConfig) => path.resolve(destinationConfig));
    const internalAppDirectory = path.join(source, INTERNAL_APP_DIRECTORY_NAME);
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
        internalAppDirectory,
        errorLogPath,
        queueFilePath,
        fileEventDebounceMs,
        queuedFileEvents: new Map<string, IQueuedFileEvent>(),
        recoveredQueuePaths: [],
        fileEventBurstCount: 0,
        queuePersistencePromise: Promise.resolve()
    };

    registerManagedStdoutLogPath(path.join(internalAppDirectory, LAUNCH_AGENT_LOG_FILE_NAME));
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
    log(`Loaded ${ignoreFiles.length} ${IGNORE_FILE_NAME} file(s).`);
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
 * @param isDirectory Whether the path should be evaluated as a directory candidate.
 */
function isIgnored(runtime: IJobRuntime, absolutePath: string, isDirectory: boolean = false): boolean {
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

        const result = testIgnoreMatcher(ignoreFile.matcher, candidate, isDirectory);
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
 * @param options Optional controls for the sync pass.
 */
async function runFullSync(runtime: IJobRuntime, label: string, options: IRunFullSyncOptions = {}): Promise<void> {
    const shouldLogSyncedEntries = options.shouldLogSyncedEntries ?? true;
    log(`${label} started.`);

    try {
        await visitSourceDirectories(runtime, runtime.config.source, async (absoluteDirectoryPath) => {
            await syncDirectory(runtime, absoluteDirectoryPath, shouldLogSyncedEntries);
        });

        await visitSourceFiles(runtime, runtime.config.source, async (sourceFile) => {
            await syncFile(runtime, sourceFile.absolutePath, sourceFile.fileState, true, shouldLogSyncedEntries);
        });

        if (runtime.config.deleteMissing) {
            await pruneDestinations(runtime);
        }
    } catch (error) {
        await appendOperationalErrorLog(runtime, label.toLowerCase(), runtime.config.source, error);
        throw error;
    }

    log(`${label} completed.`);
}

/**
 * Runs a one-shot reconciliation for every configured job and exits.
 *
 * @param runtimes Prepared runtimes for the current config.
 */
async function reconcileRuntimes(runtimes: IJobRuntime[]): Promise<void> {
    for (const runtime of runtimes) {
        await runFullSync(runtime, "Manual reconciliation", {
            shouldLogSyncedEntries: false
        });
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

        log(`Analysis completed: ${analysis.fileCount} file(s), ${analysis.totalSizeBytes} bytes (${formatBytes(analysis.totalSizeBytes)}). Log: ${analysis.logPath}`);
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
        logPath: path.join(runtime.internalAppDirectory, ANALYSIS_LOG_FILE_NAME),
        destinationAnalyses: runtime.config.destinations.map(createEmptyDestinationAnalysis)
    };

    await visitSourceFiles(runtime, runtime.config.source, async (sourceFile) => {
        analysis.fileCount += 1;
        analysis.totalSizeBytes += sourceFile.fileState.size;
        await updateDestinationAnalysesForSourceFile(runtime, analysis.destinationAnalyses, sourceFile);
    });
    await finalizeDestinationAnalyses(runtime, analysis.destinationAnalyses);
    await writeRuntimeAnalysisLog(runtime, analysis);
    return analysis;
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

    for (const destinationAnalysis of analysis.destinationAnalyses) {
        reportLines.push(
            "",
            `Destination: ${destinationAnalysis.path}`,
            `Tracked files: ${destinationAnalysis.fileCount}`,
            `Tracked size bytes: ${destinationAnalysis.totalSizeBytes}`,
            `Tracked size human: ${formatBytes(destinationAnalysis.totalSizeBytes)}`,
            `Missing files: ${destinationAnalysis.missingFileCount}`,
            `Outdated files: ${destinationAnalysis.outdatedFileCount}`,
            `Extra files: ${destinationAnalysis.extraFileCount}`
        );
    }

    await ensureOperationalStateDirectory(runtime);
    await fs.writeFile(analysis.logPath, `${reportLines.join("\n")}\n`, "utf8");
}

/**
 * Installs or refreshes the globally available CLI in the user's home directory.
 *
 * @param argv Raw process arguments.
 */
async function installCli(argv: string[] = process.argv): Promise<void> {
    const installEnvironment = await createInstallEnvironment(argv);
    const globalInstallPaths = createGlobalInstallPaths(installEnvironment.homeDirectoryPath);
    await installGlobalCli(installEnvironment, globalInstallPaths);

    log(`Installed global CLI to ${globalInstallPaths.globalInstallDirectoryPath}.`);
}

/**
 * Creates the files required to mirror a source folder into a destination folder.
 *
 * @param argv Raw process arguments.
 */
async function setupCli(argv: string[] = process.argv): Promise<void> {
    const setupArguments = parseSetupArguments(argv);
    const installEnvironment = await createInstallEnvironment(argv);
    const setupPaths = createInstallPaths(setupArguments, installEnvironment.homeDirectoryPath);
    await ensureGlobalCliInstalled(setupPaths);

    const installPaths = await setupMirror(setupArguments, installEnvironment);

    log(`Setup completed for ${setupArguments.sourcePath}. Config: ${installPaths.configPath}`);
    if (installEnvironment.platform === "darwin") {
        log(`launchd automation installed: ${installPaths.launchAgentPath}`);
    } else {
        log("launchd automation skipped because the current platform is not macOS.");
    }
}

/**
 * Parses the `setup` command arguments.
 *
 * @param argv Raw process arguments.
 */
function parseSetupArguments(argv: string[] = process.argv): IInstallArguments {
    const rawArguments = argv.slice(2);
    if (normalizeCliCommandName(rawArguments[0]) !== "setup") {
        throw new Error("Setup arguments can only be parsed for the setup command.");
    }

    let sourcePath: string | undefined;
    let destinationPath: string | undefined;

    for (let argumentIndex = 1; argumentIndex < rawArguments.length; argumentIndex += 1) {
        const argument = rawArguments[argumentIndex];

        if (argument === "-s" || argument === "--source") {
            sourcePath = readInstallOptionValue(rawArguments, argumentIndex, argument);
            argumentIndex += 1;
            continue;
        }

        if (argument === "-d" || argument === "--destination") {
            destinationPath = readInstallOptionValue(rawArguments, argumentIndex, argument);
            argumentIndex += 1;
            continue;
        }

        throw new Error(`Unknown setup argument: ${argument}. Usage: fmirror setup -s <source-path> -d <destination-path>`);
    }

    if (!sourcePath || !destinationPath) {
        throw new Error("Setup requires both -s <source-path> and -d <destination-path>.");
    }

    return {
        sourcePath: resolveCliInputPath(sourcePath),
        destinationPath: resolveCliInputPath(destinationPath)
    };
}

/**
 * Reads the value associated with a setup option flag.
 *
 * @param rawArguments Raw CLI arguments after the executable path.
 * @param optionIndex Index of the option flag inside `rawArguments`.
 * @param optionName Option currently being processed.
 */
function readInstallOptionValue(rawArguments: string[], optionIndex: number, optionName: string): string {
    const optionValue = rawArguments[optionIndex + 1];
    if (!optionValue || optionValue.startsWith("-")) {
        throw new Error(`Missing value for ${optionName}. Usage: fmirror setup -s <source-path> -d <destination-path>`);
    }

    return optionValue;
}

/**
 * Resolves a CLI path argument using the current working directory as its base.
 *
 * @param inputPath Raw CLI path value.
 */
function resolveCliInputPath(inputPath: string): string {
    return resolveConfiguredPath(inputPath, process.cwd());
}

/**
 * Resolves the runtime environment required by the install command.
 *
 * @param argv Raw process arguments.
 */
async function createInstallEnvironment(argv: string[] = process.argv): Promise<IInstallEnvironment> {
    const platform = process.platform;

    return {
        bundlePath: await resolveInstallBundlePath(argv),
        templateDirectoryPath: await resolveTemplateDirectoryPath(argv),
        nodeExecutablePath: process.execPath,
        homeDirectoryPath: os.homedir(),
        platform,
        shellProfilePath: await resolveShellProfilePath(platform),
        launchdDomainTarget: platform === "darwin" ? resolveLaunchdDomainTarget() : undefined,
        executeCommand: runCommand
    };
}

/**
 * Creates or refreshes the setup-managed files for a single source/destination pair.
 *
 * @param installArguments Parsed setup arguments.
 * @param installEnvironment Runtime environment used by the install flow.
 */
async function setupMirror(installArguments: IInstallArguments, installEnvironment: IInstallEnvironment): Promise<IInstallPaths> {
    await validateInstallArguments(installArguments);

    const installPaths = createInstallPaths(installArguments, installEnvironment.homeDirectoryPath);
    const configTemplateContent = await readTemplateContent(installEnvironment.templateDirectoryPath, CONFIG_TEMPLATE_FILE_NAME);
    const ignoreTemplateContent = await readTemplateContent(installEnvironment.templateDirectoryPath, IGNORE_TEMPLATE_FILE_NAME);

    await fs.ensureDir(installPaths.internalAppDirectoryPath);
    await fs.ensureFile(installPaths.launchAgentLogPath);
    await fs.ensureFile(installPaths.launchAgentErrorLogPath);

    const configContent = await renderInstallConfigContent(configTemplateContent, installArguments, installPaths.configPath);
    await fs.writeFile(installPaths.configPath, configContent, "utf8");
    await ensureDefaultIgnoreFile(installPaths.ignorePath, ignoreTemplateContent);

    if (installEnvironment.platform !== "darwin") {
        return installPaths;
    }

    if (!installEnvironment.launchdDomainTarget) {
        throw new Error("The current macOS session does not expose a launchd user domain.");
    }

    const launchAgentTemplateContent = await readTemplateContent(installEnvironment.templateDirectoryPath, LAUNCH_AGENT_TEMPLATE_FILE_NAME);
    const launchAgentContent = renderLaunchAgentTemplate(launchAgentTemplateContent, {
        label: installPaths.launchAgentLabel,
        workingDirectoryPath: installArguments.sourcePath,
        nodeExecutablePath: installEnvironment.nodeExecutablePath,
        bundlePath: installPaths.installedBundlePath,
        configPath: installPaths.configPath,
        standardOutPath: installPaths.launchAgentLogPath,
        standardErrorPath: installPaths.launchAgentErrorLogPath
    });

    await fs.ensureDir(path.dirname(installPaths.launchAgentPath));
    await fs.writeFile(installPaths.launchAgentPath, launchAgentContent, "utf8");
    await installLaunchAgent(installEnvironment, installPaths);
    await ensureManagedSymlink(installPaths.launchAgentSymlinkPath, installPaths.launchAgentPath);

    return installPaths;
}

/**
 * Validates the install source and destination paths before writing files.
 *
 * @param installArguments Parsed install arguments.
 */
async function validateInstallArguments(installArguments: IInstallArguments): Promise<void> {
    const sourceStats = await readExistingPathStats(installArguments.sourcePath);
    if (!sourceStats) {
        throw new Error(`Source folder does not exist: ${installArguments.sourcePath}`);
    }

    if (!sourceStats.isDirectory()) {
        throw new Error(`Source path must be a directory: ${installArguments.sourcePath}`);
    }

    const destinationStats = await readExistingPathStats(installArguments.destinationPath);
    if (destinationStats && !destinationStats.isDirectory()) {
        throw new Error(`Destination path must be a directory when it already exists: ${installArguments.destinationPath}`);
    }

    const normalizedSourcePath = normalizeComparablePath(installArguments.sourcePath);
    const normalizedDestinationPath = normalizeComparablePath(installArguments.destinationPath);
    if (pathsOverlap(normalizedSourcePath, normalizedDestinationPath)) {
        throw new Error(`Source and destination paths must not overlap: ${installArguments.sourcePath} <-> ${installArguments.destinationPath}`);
    }
}

/**
 * Creates the derived file-system paths used by the install command.
 *
 * @param installArguments Parsed install arguments.
 * @param homeDirectoryPath Current user home directory.
 */
function createInstallPaths(installArguments: IInstallArguments, homeDirectoryPath: string): IInstallPaths {
    const sourceFolderSlug = createSourceFolderSlug(installArguments.sourcePath);
    const globalInstallPaths = createGlobalInstallPaths(homeDirectoryPath);
    const internalAppDirectoryPath = path.join(installArguments.sourcePath, INTERNAL_APP_DIRECTORY_NAME);
    const configPath = path.join(internalAppDirectoryPath, INSTALL_CONFIG_FILE_NAME);
    const ignorePath = path.join(installArguments.sourcePath, IGNORE_FILE_NAME);
    const launchAgentFileName = `com.fmirror-${sourceFolderSlug}.plist`;
    const launchAgentPath = path.join(homeDirectoryPath, "Library", LAUNCH_AGENT_DIRECTORY_NAME, launchAgentFileName);
    const launchAgentSymlinkPath = path.join(internalAppDirectoryPath, launchAgentFileName);

    return {
        ...globalInstallPaths,
        sourceFolderSlug,
        internalAppDirectoryPath,
        configPath,
        ignorePath,
        launchAgentLabel: createLaunchAgentLabel(sourceFolderSlug),
        launchAgentFileName,
        launchAgentPath,
        launchAgentSymlinkPath,
        launchAgentLogPath: path.join(internalAppDirectoryPath, LAUNCH_AGENT_LOG_FILE_NAME),
        launchAgentErrorLogPath: path.join(internalAppDirectoryPath, LAUNCH_AGENT_ERROR_LOG_FILE_NAME)
    };
}

/**
 * Creates the derived file-system paths used by the global CLI installation.
 *
 * @param homeDirectoryPath Current user home directory.
 */
function createGlobalInstallPaths(homeDirectoryPath: string): IGlobalInstallPaths {
    const globalInstallDirectoryPath = path.join(homeDirectoryPath, INSTALL_DIRECTORY_NAME);

    return {
        globalInstallDirectoryPath,
        installedBundlePath: path.join(globalInstallDirectoryPath, INSTALL_BUNDLE_FILE_NAME),
        installedExecutablePath: path.join(globalInstallDirectoryPath, INSTALL_EXECUTABLE_FILE_NAME),
        installedTemplateDirectoryPath: path.join(globalInstallDirectoryPath, TEMPLATE_DIRECTORY_NAME)
    };
}

/**
 * Creates a stable slug derived from the source folder name.
 *
 * @param sourcePath Absolute source path.
 */
function createSourceFolderSlug(sourcePath: string): string {
    const sourceFolderName = path.basename(path.resolve(sourcePath)) || "source";
    const slug = sourceFolderName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return slug || "source";
}

/**
 * Creates the launch agent label associated with an installed source folder.
 *
 * @param sourceFolderSlug Slug derived from the source folder name.
 */
function createLaunchAgentLabel(sourceFolderSlug: string): string {
    return `com.fmirror.${sourceFolderSlug}`;
}

/**
 * Installs or refreshes the globally available CLI used by interactive runs and launchd.
 *
 * @param installEnvironment Runtime environment used by the install flow.
 * @param installPaths Derived install paths.
 */
async function installGlobalCli(installEnvironment: IInstallEnvironment, installPaths: IGlobalInstallPaths): Promise<void> {
    await fs.ensureDir(installPaths.globalInstallDirectoryPath);

    if (path.resolve(installEnvironment.bundlePath) !== path.resolve(installPaths.installedBundlePath)) {
        await fs.copyFile(installEnvironment.bundlePath, installPaths.installedBundlePath);
    }
    if (path.resolve(installEnvironment.templateDirectoryPath) !== path.resolve(installPaths.installedTemplateDirectoryPath)) {
        await fs.copy(installEnvironment.templateDirectoryPath, installPaths.installedTemplateDirectoryPath, {
            overwrite: true,
            errorOnExist: false
        });
    }

    await fs.writeFile(installPaths.installedExecutablePath, createInstalledLauncherContent(), "utf8");
    await fs.chmod(installPaths.installedExecutablePath, 0o755);

    if (installEnvironment.shellProfilePath) {
        await ensurePathExport(installEnvironment.shellProfilePath, installPaths.globalInstallDirectoryPath);
    }
}

/**
 * Ensures the global CLI files required by `setup` already exist.
 *
 * @param installPaths Derived paths used by the setup flow.
 */
async function ensureGlobalCliInstalled(installPaths: IGlobalInstallPaths): Promise<void> {
    const hasInstalledBundle = await fs.pathExists(installPaths.installedBundlePath);
    const hasInstalledExecutable = await fs.pathExists(installPaths.installedExecutablePath);
    const hasInstalledTemplates = (await readExistingPathStats(installPaths.installedTemplateDirectoryPath))?.isDirectory() ?? false;

    if (hasInstalledBundle && hasInstalledExecutable && hasInstalledTemplates) {
        return;
    }

    throw new Error(`Global CLI is not installed. Run "fmirror install" first. Expected files under ${installPaths.globalInstallDirectoryPath}`);
}

/**
 * Resolves the built bundle that should be copied into the global install directory.
 *
 * @param argv Raw process arguments.
 */
async function resolveInstallBundlePath(argv: string[] = process.argv): Promise<string> {
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
 * Chooses the shell profile file that should receive the PATH export for the globally installed CLI.
 *
 * @param platform Current runtime platform.
 */
async function resolveShellProfilePath(platform: NodeJS.Platform): Promise<string | undefined> {
    if (platform === "win32") {
        return undefined;
    }

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
 * Appends the global install directory to the selected shell profile when the block is not already present.
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
 * Creates the executable launcher script installed into the global CLI directory.
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
 * Resolves the directory that contains the install templates.
 *
 * @param argv Raw process arguments.
 */
async function resolveTemplateDirectoryPath(argv: string[] = process.argv): Promise<string> {
    const executablePath = argv[1] ? path.resolve(argv[1]) : undefined;
    const candidateTemplateDirectories = new Set<string>([
        path.resolve(process.cwd(), TEMPLATE_DIRECTORY_NAME)
    ]);

    if (executablePath) {
        candidateTemplateDirectories.add(path.resolve(path.dirname(executablePath), TEMPLATE_DIRECTORY_NAME));
        candidateTemplateDirectories.add(path.resolve(path.dirname(executablePath), "..", TEMPLATE_DIRECTORY_NAME));
    }

    for (const candidateTemplateDirectory of candidateTemplateDirectories) {
        const candidateStats = await readExistingPathStats(candidateTemplateDirectory);
        if (candidateStats?.isDirectory()) {
            return candidateTemplateDirectory;
        }
    }

    throw new Error(`Template directory not found. Expected a ${TEMPLATE_DIRECTORY_NAME} folder near the current build output.`);
}

/**
 * Reads a template file from disk.
 *
 * @param templateDirectoryPath Directory that contains the install templates.
 * @param templateFileName Template file name to read.
 */
async function readTemplateContent(templateDirectoryPath: string, templateFileName: string): Promise<string> {
    return fs.readFile(path.join(templateDirectoryPath, templateFileName), "utf8");
}

/**
 * Renders the install-managed config file, preserving selected user overrides when a config already exists.
 *
 * @param templateContent Raw config template content.
 * @param installArguments Parsed install arguments.
 * @param configPath Final config path written by the install flow.
 */
async function renderInstallConfigContent(templateContent: string, installArguments: IInstallArguments, configPath: string): Promise<string> {
    const templateDefaults = readInstallTemplateDefaults(templateContent);
    const existingConfig = await readExistingInstallConfig(configPath);
    const existingJob = readFirstExistingConfigJob(existingConfig);

    const installConfig: IAppConfig = validateAppConfig({
        debounceMs: isNonNegativeInteger(existingConfig?.debounceMs) ? existingConfig.debounceMs : templateDefaults.debounceMs,
        fileDebounceMs: isNonNegativeInteger(existingConfig?.fileDebounceMs) ? existingConfig.fileDebounceMs : templateDefaults.fileDebounceMs,
        jobs: [
            {
                name: readOptionalNonEmptyString(existingJob?.name) ?? createDefaultInstallJobName(installArguments.sourcePath),
                source: installArguments.sourcePath,
                destinations: [
                    installArguments.destinationPath
                ],
                deleteMissing: typeof existingJob?.deleteMissing === "boolean" ? existingJob.deleteMissing : templateDefaults.deleteMissing,
                watchHidden: typeof existingJob?.watchHidden === "boolean" ? existingJob.watchHidden : templateDefaults.watchHidden
            }
        ]
    }, path.dirname(configPath));

    return `${JSON.stringify(installConfig, null, 4)}\n`;
}

/**
 * Reads the numeric and boolean defaults from the config template.
 *
 * @param templateContent Raw config template content.
 */
function readInstallTemplateDefaults(templateContent: string): {
    debounceMs: number;
    fileDebounceMs: number;
    deleteMissing: boolean;
    watchHidden: boolean;
} {
    let parsedTemplate: unknown;

    try {
        parsedTemplate = JSON.parse(templateContent);
    } catch (error) {
        throw new Error(`Invalid config template JSON: ${formatError(error)}`);
    }

    if (!isPlainObject(parsedTemplate) || !Array.isArray(parsedTemplate.jobs) || parsedTemplate.jobs.length === 0 || !isPlainObject(parsedTemplate.jobs[0])) {
        throw new Error("Config template must contain a non-empty jobs array.");
    }

    const templateJob = parsedTemplate.jobs[0];
    return {
        debounceMs: isNonNegativeInteger(parsedTemplate.debounceMs) ? parsedTemplate.debounceMs : DEFAULT_DEBOUNCE_MS,
        fileDebounceMs: isNonNegativeInteger(parsedTemplate.fileDebounceMs) ? parsedTemplate.fileDebounceMs : DEFAULT_FILE_EVENT_DEBOUNCE_MS,
        deleteMissing: typeof templateJob.deleteMissing === "boolean" ? templateJob.deleteMissing : true,
        watchHidden: typeof templateJob.watchHidden === "boolean" ? templateJob.watchHidden : true
    };
}

/**
 * Reads an existing install-managed config file so selected values can be preserved across reruns.
 *
 * @param configPath Absolute config path managed by the install command.
 */
async function readExistingInstallConfig(configPath: string): Promise<Partial<IAppConfig> | undefined> {
    if (!(await fs.pathExists(configPath))) {
        return undefined;
    }

    let parsedConfig: unknown;

    try {
        parsedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
        throw new Error(`Existing install config is not valid JSON: ${configPath}. ${formatError(error)}`);
    }

    if (!isPlainObject(parsedConfig)) {
        throw new Error(`Existing install config must contain an object: ${configPath}`);
    }

    return parsedConfig as Partial<IAppConfig>;
}

/**
 * Reads the first job from an existing config when it matches the expected object shape.
 *
 * @param existingConfig Existing install-managed config.
 */
function readFirstExistingConfigJob(existingConfig: Partial<IAppConfig> | undefined): Partial<IJobConfig> | undefined {
    if (!existingConfig || !Array.isArray(existingConfig.jobs) || existingConfig.jobs.length === 0 || !isPlainObject(existingConfig.jobs[0])) {
        return undefined;
    }

    return existingConfig.jobs[0] as Partial<IJobConfig>;
}

/**
 * Builds the default job name stored in an install-managed config.
 *
 * @param sourcePath Absolute source path configured by install.
 */
function createDefaultInstallJobName(sourcePath: string): string {
    return path.basename(path.resolve(sourcePath)) || "source";
}

/**
 * Renders the macOS LaunchAgent plist from the provided template.
 *
 * @param templateContent Raw LaunchAgent template content.
 * @param templateValues Placeholder values injected into the template.
 */
function renderLaunchAgentTemplate(templateContent: string, templateValues: {
    label: string;
    workingDirectoryPath: string;
    nodeExecutablePath: string;
    bundlePath: string;
    configPath: string;
    standardOutPath: string;
    standardErrorPath: string;
}): string {
    return replaceTemplateTokens(templateContent, {
        LABEL: escapeXml(templateValues.label),
        WORKING_DIRECTORY: escapeXml(templateValues.workingDirectoryPath),
        NODE_PATH: escapeXml(templateValues.nodeExecutablePath),
        BUNDLE_PATH: escapeXml(templateValues.bundlePath),
        CONFIG_PATH: escapeXml(templateValues.configPath),
        STANDARD_OUT_PATH: escapeXml(templateValues.standardOutPath),
        STANDARD_ERROR_PATH: escapeXml(templateValues.standardErrorPath)
    });
}

/**
 * Replaces `{{TOKEN}}` placeholders inside a template string.
 *
 * @param templateContent Raw template content.
 * @param replacements Token replacements keyed by placeholder name.
 */
function replaceTemplateTokens(templateContent: string, replacements: Record<string, string>): string {
    return templateContent.replace(/\{\{([A-Z_]+)\}\}/g, (_fullMatch, key: string) => replacements[key] ?? _fullMatch);
}

/**
 * Escapes XML-special characters for values injected into the plist template.
 *
 * @param value Raw string value.
 */
function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Ensures the default `.fmirror-ignore` file exists without overwriting a user-managed file.
 *
 * @param ignorePath Absolute ignore file path.
 * @param templateContent Raw ignore template content.
 */
async function ensureDefaultIgnoreFile(ignorePath: string, templateContent: string): Promise<void> {
    if (await fs.pathExists(ignorePath)) {
        return;
    }

    const normalizedContent = templateContent.endsWith("\n") ? templateContent : `${templateContent}\n`;
    await fs.writeFile(ignorePath, normalizedContent, "utf8");
}

/**
 * Installs or reloads the launchd agent associated with an installed source folder.
 *
 * @param installEnvironment Runtime environment used by the install flow.
 * @param installPaths Derived install paths.
 */
async function installLaunchAgent(installEnvironment: IInstallEnvironment, installPaths: IInstallPaths): Promise<void> {
    if (!installEnvironment.launchdDomainTarget) {
        throw new Error("Missing launchd domain target for macOS installation.");
    }

    await installEnvironment.executeCommand("launchctl", [
        "bootout",
        installEnvironment.launchdDomainTarget,
        installPaths.launchAgentPath
    ], true);

    await installEnvironment.executeCommand("launchctl", [
        "bootstrap",
        installEnvironment.launchdDomainTarget,
        installPaths.launchAgentPath
    ]);
}

/**
 * Creates or refreshes a symbolic link that points to the installed launch agent file.
 *
 * @param linkPath Absolute path of the managed symbolic link.
 * @param targetPath Absolute path of the installed launch agent file.
 */
async function ensureManagedSymlink(linkPath: string, targetPath: string): Promise<void> {
    try {
        const linkStats = await fs.lstat(linkPath);
        if (linkStats.isSymbolicLink()) {
            const currentTargetPath = await fs.readlink(linkPath);
            const resolvedTargetPath = path.resolve(path.dirname(linkPath), currentTargetPath);
            if (resolvedTargetPath === path.resolve(targetPath)) {
                return;
            }
        }

        await fs.remove(linkPath);
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
    }

    await fs.symlink(targetPath, linkPath);
}

/**
 * Resolves the launchd domain used to register user agents on macOS.
 */
function resolveLaunchdDomainTarget(): string {
    if (typeof process.getuid !== "function") {
        throw new Error("Unable to resolve the current user id for launchd.");
    }

    return `gui/${process.getuid()}`;
}

/**
 * Executes a child process without going through a shell.
 *
 * @param command Executable name.
 * @param argumentsList Argument list passed to the executable.
 * @param ignoreFailure When `true`, command failures are ignored.
 */
async function runCommand(command: string, argumentsList: string[], ignoreFailure = false): Promise<void> {
    try {
        await execFileAsync(command, argumentsList);
    } catch (error) {
        if (ignoreFailure) {
            return;
        }

        throw new Error(formatCommandError(command, argumentsList, error));
    }
}

/**
 * Formats a failed child-process execution into a readable error string.
 *
 * @param command Executable name.
 * @param argumentsList Argument list passed to the executable.
 * @param error Raw execution error.
 */
function formatCommandError(command: string, argumentsList: string[], error: unknown): string {
    if (!error || typeof error !== "object") {
        return `${command} ${argumentsList.join(" ")} failed: ${formatError(error)}`;
    }

    const candidate = error as {
        stderr?: unknown;
        stdout?: unknown;
        message?: unknown;
    };
    const detail = readOptionalNonEmptyString(candidate.stderr) ?? readOptionalNonEmptyString(candidate.stdout) ?? readOptionalNonEmptyString(candidate.message) ?? formatError(error);
    return `${command} ${argumentsList.join(" ")} failed: ${detail}`;
}

/**
 * Recursively visits mirrored source directories without materializing the whole source tree in memory.
 *
 * @param runtime Runtime state for the current job.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param visitor Async callback invoked for each mirrored source directory.
 */
async function visitSourceDirectories(runtime: IJobRuntime, currentDirectory: string, visitor: (absoluteDirectoryPath: string) => Promise<void>): Promise<void> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }

        throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const absoluteEntryPath = path.join(currentDirectory, entry.name);
        if (!shouldMirrorSourcePath(runtime, absoluteEntryPath, true)) {
            continue;
        }

        await visitor(absoluteEntryPath);
        await visitSourceDirectories(runtime, absoluteEntryPath, visitor);
    }
}

/**
 * Recursively visits mirrored source files without materializing the whole source tree in memory.
 *
 * @param runtime Runtime state for the current job.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param visitor Async callback invoked for each mirrored source file.
 */
async function visitSourceFiles(runtime: IJobRuntime, currentDirectory: string, visitor: (sourceFile: ISourceFileVisit) => Promise<void>): Promise<void> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }

        throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);
        if (!shouldMirrorSourcePath(runtime, absoluteEntryPath, false)) {
            continue;
        }

        if (entry.isDirectory()) {
            await visitSourceFiles(runtime, absoluteEntryPath, visitor);
            continue;
        }

        const entryStats = await readExistingPathStats(absoluteEntryPath);
        if (!entryStats || !entryStats.isFile()) {
            continue;
        }

        await visitor({
            absolutePath: absoluteEntryPath,
            relativePath: getRelativePathFromSource(runtime.config.source, absoluteEntryPath),
            fileState: toFileState(entryStats)
        });
    }
}

/**
 * Creates the empty analysis accumulator for a destination before source and destination scans run.
 *
 * @param destination Destination path being analyzed.
 */
function createEmptyDestinationAnalysis(destination: string): IDestinationAnalysis {
    return {
        path: destination,
        fileCount: 0,
        totalSizeBytes: 0,
        missingFileCount: 0,
        outdatedFileCount: 0,
        extraFileCount: 0
    };
}

/**
 * Updates destination analysis counters for one source file by checking the corresponding destination paths directly.
 *
 * @param runtime Runtime state for the current job.
 * @param destinationAnalyses Mutable destination analysis list.
 * @param sourceFile Source file currently being analyzed.
 */
async function updateDestinationAnalysesForSourceFile(runtime: IJobRuntime, destinationAnalyses: IDestinationAnalysis[], sourceFile: ISourceFileVisit): Promise<void> {
    for (const destinationAnalysis of destinationAnalyses) {
        const destinationPath = resolveRelativePath(destinationAnalysis.path, sourceFile.relativePath);
        const destinationStats = await readExistingPathStats(destinationPath);

        if (!destinationStats || !destinationStats.isFile()) {
            destinationAnalysis.missingFileCount += 1;
            continue;
        }

        if (!areFileStatesEquivalent(sourceFile.fileState, toFileState(destinationStats))) {
            destinationAnalysis.outdatedFileCount += 1;
        }
    }
}

/**
 * Completes destination analysis counters by scanning each destination tree and classifying extra files.
 *
 * @param runtime Runtime state for the current job.
 * @param destinationAnalyses Mutable destination analysis list.
 */
async function finalizeDestinationAnalyses(runtime: IJobRuntime, destinationAnalyses: IDestinationAnalysis[]): Promise<void> {
    for (const destinationAnalysis of destinationAnalyses) {
        const destinationFileStates = await buildDestinationFileStateMap(destinationAnalysis.path);
        destinationAnalysis.fileCount = destinationFileStates.size;
        destinationAnalysis.totalSizeBytes = sumFileStateSize(destinationFileStates);

        for (const relativePath of destinationFileStates.keys()) {
            const sourceEntryType = await readMirrorableSourceEntryType(runtime, resolveRelativePath(runtime.config.source, relativePath));
            if (sourceEntryType !== "file") {
                destinationAnalysis.extraFileCount += 1;
            }
        }
    }
}

/**
 * Sums the total byte size tracked by a file state map.
 *
 * @param fileStates File state map to aggregate.
 */
function sumFileStateSize(fileStates: Map<string, IFileState>): number {
    let totalSizeBytes = 0;

    for (const fileState of fileStates.values()) {
        totalSizeBytes += fileState.size;
    }

    return totalSizeBytes;
}

/**
 * Builds a metadata map of the current destination tree using only file stats.
 *
 * @param destination Absolute destination root to inspect.
 */
async function buildDestinationFileStateMap(destination: string): Promise<Map<string, IFileState>> {
    const fileStates = new Map<string, IFileState>();

    if (!(await fs.pathExists(destination))) {
        return fileStates;
    }

    await collectDestinationFileStates(destination, destination, fileStates);
    return fileStates;
}

/**
 * Recursively collects destination file metadata for comparison purposes.
 *
 * @param destinationRoot Absolute root directory of the destination.
 * @param currentDirectory Absolute directory currently being scanned.
 * @param fileStates Mutable map of destination file states.
 */
async function collectDestinationFileStates(destinationRoot: string, currentDirectory: string, fileStates: Map<string, IFileState>): Promise<void> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }

        throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
            await collectDestinationFileStates(destinationRoot, absoluteEntryPath, fileStates);
            continue;
        }

        const entryStats = await readExistingPathStats(absoluteEntryPath);
        if (!entryStats) {
            continue;
        }

        if (!entryStats.isFile()) {
            continue;
        }

        fileStates.set(getRelativePathFromSource(destinationRoot, absoluteEntryPath), {
            size: entryStats.size,
            mtimeMs: entryStats.mtimeMs
        });
    }
}

/**
 * Removes stale files and directories from every destination by checking whether the mirrored source path still exists.
 *
 * @param runtime Runtime state for the current job.
 */
async function pruneDestinations(runtime: IJobRuntime): Promise<void> {
    for (const destination of runtime.config.destinations) {
        if (!(await fs.pathExists(destination))) {
            continue;
        }

        await pruneDestination(runtime, destination, destination);
    }
}

/**
 * Removes stale files and directories from a destination tree using source-path existence and type checks.
 *
 * @param runtime Runtime state for the current job.
 * @param destinationRoot Absolute destination root.
 * @param currentDirectory Absolute destination directory currently being scanned.
 */
async function pruneDestination(runtime: IJobRuntime, destinationRoot: string, currentDirectory: string): Promise<void> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }

        throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const absoluteEntryPath = path.join(currentDirectory, entry.name);
        const relativePath = getRelativePathFromSource(destinationRoot, absoluteEntryPath);
        const sourcePath = resolveRelativePath(runtime.config.source, relativePath);

        if (entry.isDirectory()) {
            await pruneDestination(runtime, destinationRoot, absoluteEntryPath);

            if ((await readMirrorableSourceEntryType(runtime, sourcePath)) === "directory") {
                continue;
            }

            await fs.remove(absoluteEntryPath);
            log(`Deleted stale directory ${relativePath}`);
            continue;
        }

        if ((await readMirrorableSourceEntryType(runtime, sourcePath)) === "file") {
            continue;
        }

        await fs.remove(absoluteEntryPath);
        log(`Deleted stale file ${relativePath}`);
    }
}

/**
 * Starts the filesystem watcher for a runtime and wires all sync-related event handlers.
 *
 * @param runtime Runtime state for the current job.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 */
async function startWatcher(runtime: IJobRuntime, debounceMs: number): Promise<boolean> {
    let watcher: IWatchSession | undefined;

    try {
        watcher = await createWatcher(runtime, debounceMs);
        runtime.watcher = watcher;
    } catch (error) {
        await handleWatcherStartupError(runtime, watcher, error);
        return false;
    }

    log(`Watcher ready.`);
    return true;
}

/**
 * Creates and wires a Watchman subscription session for the current runtime.
 *
 * @param runtime Runtime state for the current job.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 */
async function createWatcher(runtime: IJobRuntime, debounceMs: number): Promise<IWatchSession> {
    const watchProjectResponse = await runWatchmanCommand<IWatchmanWatchProjectResponse>([
        "watch-project",
        runtime.config.source
    ]);
    const watchRoot = watchProjectResponse.watch;
    const relativeRoot = watchProjectResponse.relative_path;
    const clockResponse = await runWatchmanCommand<IWatchmanClockResponse>([
        "clock",
        watchRoot
    ]);
    return await createWatchmanSubscriptionSession(runtime, debounceMs, watchRoot, relativeRoot, clockResponse.clock);
}

/**
 * Handles watcher startup failures without aborting the full process when one job cannot be watched.
 *
 * @param runtime Runtime state for the current job.
 * @param watcher Watcher that failed during startup.
 * @param error Error raised by Watchman startup.
 */
async function handleWatcherStartupError(runtime: IJobRuntime, watcher: IWatchSession | undefined, error: unknown): Promise<void> {
    if (watcher && runtime.watcher === watcher) {
        runtime.watcher = undefined;
    }

    if (watcher) {
        await closeWatcherSafely(watcher);
    }

    if (!shouldLogWatcherError(runtime, error)) {
        return;
    }

    await appendOperationalErrorLog(runtime, "watcher", runtime.config.source, error);
    log(`Watcher start failed: ${formatWatcherErrorMessage(error)}`);
}

/**
 * Handles watcher errors raised after startup and throttles repeated logs for noisy watcher failures.
 *
 * @param runtime Runtime state for the current job.
 * @param watcher Watcher that raised the error.
 * @param error Error raised by Watchman.
 */
async function handleWatcherRuntimeError(runtime: IJobRuntime, watcher: IWatchSession, error: unknown): Promise<void> {
    if (runtime.watcher !== watcher) {
        return;
    }

    if (!shouldLogWatcherError(runtime, error)) {
        return;
    }

    await appendOperationalErrorLog(runtime, "watcher", runtime.config.source, error);
    log(`Watcher error: ${formatWatcherErrorMessage(error)}`);
}

/**
 * Closes a watcher instance and ignores shutdown failures because recovery is already in progress.
 *
 * @param watcher Watcher instance to close.
 */
async function closeWatcherSafely(watcher: IWatchSession): Promise<void> {
    try {
        await watcher.close();
    } catch {
        return;
    }
}

/**
 * Executes a single Watchman JSON command and resolves the parsed response object.
 *
 * @param command Watchman command payload.
 */
async function runWatchmanCommand<TResponse extends { error?: string; warning?: string; }>(command: unknown[]): Promise<TResponse> {
    const watchmanExecutablePath = await resolveWatchmanExecutablePath();

    return await new Promise<TResponse>((resolve, reject) => {
        const process = spawn(watchmanExecutablePath, WATCHMAN_COMMAND_ARGUMENTS, {
            stdio: [
                "pipe",
                "pipe",
                "pipe"
            ]
        });
        let stdout = "";
        let stderr = "";

        process.stdout.setEncoding("utf8");
        process.stderr.setEncoding("utf8");
        process.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        process.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        process.once("error", (error: Error) => {
            reject(createWatchmanCommandError(error, stderr));
        });
        process.once("close", (code) => {
            if (code !== 0) {
                reject(new Error(createWatchmanProcessFailureMessage(code, stderr, stdout)));
                return;
            }

            try {
                const response = JSON.parse(stdout.trim()) as TResponse;
                if (response.warning) {
                    log(`[watchman] ${response.warning}`);
                }

                if (response.error) {
                    reject(new Error(response.error));
                    return;
                }

                resolve(response);
            } catch (error) {
                reject(new Error(`Failed to parse Watchman response: ${formatError(error)}.`));
            }
        });

        process.stdin.end(`${JSON.stringify(command)}\n`);
    });
}

/**
 * Creates the persistent Watchman client used to receive subscription notifications.
 *
 * @param runtime Runtime state for the current job.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 * @param watchRoot Effective Watchman root returned by `watch-project`.
 * @param relativeRoot Optional source-relative root inside the watched tree.
 * @param sinceClock Clock captured immediately before the subscription starts.
 */
async function createWatchmanSubscriptionSession(runtime: IJobRuntime, debounceMs: number, watchRoot: string, relativeRoot: string | undefined, sinceClock: string): Promise<IWatchmanSession> {
    const subscriptionName = createWatchmanSubscriptionName(runtime.config.name);
    const watchmanExecutablePath = await resolveWatchmanExecutablePath();

    return await new Promise<IWatchmanSession>((resolve, reject) => {
        const process = spawn(watchmanExecutablePath, [
            ...WATCHMAN_COMMAND_ARGUMENTS,
            "-p"
        ], {
            stdio: [
                "pipe",
                "pipe",
                "pipe"
            ]
        });
        const session: IWatchmanSession = {
            process,
            subscriptionName,
            isClosing: false,
            close: async () => {
                await closeWatchmanSession(session);
            }
        };
        let stderr = "";
        let stdoutBuffer = "";
        let isSubscribed = false;
        const subscribeTimeout = setTimeout(() => {
            if (isSubscribed) {
                return;
            }

            void closeWatchmanSession(session);
            reject(new Error(`Timed out while waiting for Watchman subscription '${subscriptionName}' to start.`));
        }, WATCHMAN_SUBSCRIBE_TIMEOUT_MS);

        process.stdout.setEncoding("utf8");
        process.stderr.setEncoding("utf8");
        process.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        process.once("error", (error: Error) => {
            clearTimeout(subscribeTimeout);

            if (!isSubscribed) {
                reject(createWatchmanCommandError(error, stderr));
                return;
            }

            if (!session.isClosing) {
                void handleWatcherRuntimeError(runtime, session, createWatchmanCommandError(error, stderr));
            }
        });
        process.once("close", (code) => {
            clearTimeout(subscribeTimeout);

            if (!isSubscribed) {
                reject(new Error(createWatchmanProcessFailureMessage(code, stderr, stdoutBuffer)));
                return;
            }

            if (!session.isClosing) {
                void handleWatcherRuntimeError(runtime, session, new Error(createWatchmanProcessFailureMessage(code, stderr, stdoutBuffer)));
            }
        });
        process.stdout.on("data", (chunk: string) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                let message: IWatchmanSubscribeResponse | IWatchmanSubscriptionNotification;

                try {
                    message = JSON.parse(line) as IWatchmanSubscribeResponse | IWatchmanSubscriptionNotification;
                } catch (error) {
                    const parseError = new Error(`Failed to parse Watchman subscription output: ${formatError(error)}.`);

                    if (!isSubscribed) {
                        clearTimeout(subscribeTimeout);
                        reject(parseError);
                        return;
                    }

                    if (!session.isClosing) {
                        void handleWatcherRuntimeError(runtime, session, parseError);
                    }
                    return;
                }

                if ("warning" in message && message.warning) {
                    log(`[watchman] ${message.warning}`);
                }

                if (!isSubscribed) {
                    if ("error" in message && message.error) {
                        clearTimeout(subscribeTimeout);
                        void closeWatchmanSession(session);
                        reject(new Error(message.error));
                        return;
                    }

                    if ("subscribe" in message && message.subscribe === subscriptionName) {
                        clearTimeout(subscribeTimeout);
                        isSubscribed = true;
                        resolve(session);
                    }
                    continue;
                }

                if ("subscription" in message && message.subscription === subscriptionName) {
                    void handleWatchmanSubscriptionNotification(runtime, message, debounceMs).catch(async (error) => {
                        await handleWatcherRuntimeError(runtime, session, error);
                    });
                }
            }
        });

        process.stdin.write(`${JSON.stringify(buildWatchmanSubscribeCommand(watchRoot, subscriptionName, sinceClock, relativeRoot))}\n`);
    });
}

/**
 * Closes the persistent Watchman client session.
 *
 * @param watcher Watchman session to close.
 */
async function closeWatchmanSession(watcher: IWatchmanSession): Promise<void> {
    watcher.isClosing = true;

    if (!watcher.process.stdin.destroyed) {
        watcher.process.stdin.end();
    }

    if (watcher.process.exitCode !== null) {
        return;
    }

    await new Promise<void>((resolve) => {
        watcher.process.once("close", () => {
            resolve();
        });
        watcher.process.kill("SIGTERM");
    });
}

/**
 * Handles a Watchman subscription update by translating changed paths into the existing sync pipeline.
 *
 * @param runtime Runtime state for the current job.
 * @param notification Notification payload received from Watchman.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 */
async function handleWatchmanSubscriptionNotification(runtime: IJobRuntime, notification: IWatchmanSubscriptionNotification, debounceMs: number): Promise<void> {
    if (notification.error) {
        throw new Error(notification.error);
    }

    if (notification.is_fresh_instance) {
        queueRuntimeFullSync(runtime, debounceMs, "Watchman requested a full rescan.");
        return;
    }

    for (const changedFile of notification.files ?? []) {
        await handleWatchmanFileNotification(runtime, changedFile, debounceMs);
    }
}

/**
 * Maps a single Watchman file record to the corresponding sync action.
 *
 * @param runtime Runtime state for the current job.
 * @param changedFile File record received from Watchman.
 * @param debounceMs Delay used to debounce full reloads after ignore file changes.
 */
async function handleWatchmanFileNotification(runtime: IJobRuntime, changedFile: IWatchmanSubscriptionFile, debounceMs: number): Promise<void> {
    const absolutePath = path.resolve(runtime.config.source, changedFile.name);

    if (!isPathInsideSource(runtime.config.source, absolutePath)) {
        return;
    }

    if (path.basename(absolutePath) === IGNORE_FILE_NAME && !isOperationalPath(runtime.config.source, absolutePath)) {
        log(`${IGNORE_FILE_NAME} changed. Reloading rules.`);
        queueRuntimeFullSync(runtime, debounceMs, "Ignore rules changed.", true);
        return;
    }

    if (isOperationalPath(runtime.config.source, absolutePath)) {
        return;
    }

    if (changedFile.exists === false) {
        if (runtime.config.deleteMissing) {
            await deletePathFromDestinations(runtime, absolutePath);
        }
        return;
    }

    const sourceEntryType = normalizeWatchmanEntryType(changedFile.type) ?? await readMirrorableSourceEntryType(runtime, absolutePath);
    if (!sourceEntryType) {
        return;
    }

    if (sourceEntryType === "directory") {
        await handleDirectoryEvent(runtime, absolutePath, "addDir", debounceMs);
        return;
    }

    queueFileEvent(runtime, absolutePath, "change", debounceMs);
}

/**
 * Builds the Watchman subscribe command used by the persistent client.
 *
 * @param watchRoot Effective root returned by `watch-project`.
 * @param subscriptionName Subscription identifier scoped to the current job.
 * @param sinceClock Clock value captured just before the subscription begins.
 * @param relativeRoot Optional source-relative root inside the watch root.
 */
function buildWatchmanSubscribeCommand(watchRoot: string, subscriptionName: string, sinceClock: string, relativeRoot?: string): unknown[] {
    const subscriptionOptions: IWatchmanSubscriptionOptions = {
        fields: [
            "name",
            "exists",
            "type"
        ],
        since: sinceClock
    };

    if (relativeRoot) {
        subscriptionOptions.relative_root = relativeRoot;
    }

    return [
        "subscribe",
        watchRoot,
        subscriptionName,
        subscriptionOptions
    ];
}

/**
 * Creates the deterministic Watchman subscription name used for a runtime.
 *
 * @param jobName Job label from the config file.
 */
function createWatchmanSubscriptionName(jobName: string): string {
    const normalizedName = jobName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `${WATCHMAN_SUBSCRIPTION_NAME_PREFIX}${normalizedName || "watch"}`;
}

/**
 * Normalizes Watchman entry type codes to the source-entry types used by the sync pipeline.
 *
 * @param entryType Type code received from Watchman.
 */
function normalizeWatchmanEntryType(entryType: string | undefined): SourceEntryType | undefined {
    if (entryType === "d") {
        return "directory";
    }

    if (entryType === "f" || entryType === "l") {
        return "file";
    }

    return undefined;
}

/**
 * Converts child-process failures into a stable Watchman startup/runtime error.
 *
 * @param error Process-level error raised while talking to Watchman.
 * @param stderr Current stderr buffer associated with the failed process.
 */
function createWatchmanCommandError(error: Error, stderr: string): Error {
    if (readErrorCode(error) === "ENOENT") {
        return new Error("watchman command not found. Install Watchman to use watch mode.");
    }

    const stderrMessage = stderr.trim();
    if (!stderrMessage) {
        return error;
    }

    return new Error(`${error.message}. ${stderrMessage}`);
}

/**
 * Formats an unexpected Watchman process exit into a readable error string.
 *
 * @param exitCode Exit code returned by the Watchman client process.
 * @param stderr Captured stderr output.
 * @param stdout Captured stdout output that was not yet processed.
 */
function createWatchmanProcessFailureMessage(exitCode: number | null, stderr: string, stdout: string): string {
    const stderrMessage = stderr.trim();
    const stdoutMessage = stdout.trim();
    const processMessage = exitCode === null ? "Watchman process exited unexpectedly." : `Watchman process exited with code ${exitCode}.`;

    if (stderrMessage) {
        return `${processMessage} ${stderrMessage}`;
    }

    if (stdoutMessage) {
        return `${processMessage} ${stdoutMessage}`;
    }

    return processMessage;
}

/**
 * Resolves the Watchman executable path, preferring an explicit override and known macOS install locations.
 */
async function resolveWatchmanExecutablePath(): Promise<string> {
    if (cachedWatchmanExecutablePath) {
        return cachedWatchmanExecutablePath;
    }

    const configuredPath = process.env[WATCHMAN_BINARY_ENV_NAME];
    if (configuredPath) {
        cachedWatchmanExecutablePath = configuredPath;
        return configuredPath;
    }

    const candidates = process.platform === "darwin" ? [
        "/opt/homebrew/bin/watchman",
        "/usr/local/bin/watchman",
        "watchman"
    ] : [
        "watchman"
    ];

    for (const candidate of candidates) {
        if (!path.isAbsolute(candidate)) {
            cachedWatchmanExecutablePath = candidate;
            return candidate;
        }

        if (await fs.pathExists(candidate)) {
            cachedWatchmanExecutablePath = candidate;
            return candidate;
        }
    }

    cachedWatchmanExecutablePath = "watchman";
    return cachedWatchmanExecutablePath;
}

/**
 * Suppresses repeated watcher errors for a short time window so the operational log stays readable.
 *
 * @param runtime Runtime state for the current job.
 * @param error Error raised by the active watcher backend.
 */
function shouldLogWatcherError(runtime: IJobRuntime, error: unknown): boolean {
    const key = getWatcherErrorLogKey(error);
    const message = formatWatcherErrorMessage(error);
    const logWindowMs = getWatcherErrorLogWindowMs(error);
    const now = Date.now();
    const watcherErrorState = runtime.watcherErrorState;

    if (!watcherErrorState) {
        runtime.watcherErrorState = {
            key,
            message,
            suppressedCount: 0,
            lastLoggedAt: now
        };
        return true;
    }

    if (watcherErrorState.key === key && now - watcherErrorState.lastLoggedAt < logWindowMs) {
        watcherErrorState.message = message;
        watcherErrorState.suppressedCount += 1;
        return false;
    }

    runtime.watcherErrorState = {
        key,
        message,
        suppressedCount: 0,
        lastLoggedAt: now
    };
    return true;
}

/**
 * Normalizes watcher errors to a stable log message so noisy descriptor-limit failures stay deduplicated.
 *
 * @param error Error raised by the active watcher backend.
 */
function formatWatcherErrorMessage(error: unknown): string {
    if (isWatcherLimitError(error)) {
        return "Native watcher hit a system watch limit.";
    }

    return formatError(error);
}

/**
 * Maps watcher errors to a stable throttling key so equivalent failures share the same log window.
 *
 * @param error Error raised by the active watcher backend.
 */
function getWatcherErrorLogKey(error: unknown): string {
    if (isWatcherLimitError(error)) {
        return "WATCH_LIMIT";
    }

    return formatWatcherErrorMessage(error);
}

/**
 * Chooses the throttling window used for a watcher error.
 *
 * @param error Error raised by the active watcher backend.
 */
function getWatcherErrorLogWindowMs(error: unknown): number {
    if (isWatcherLimitError(error)) {
        return WATCHER_LIMIT_ERROR_LOG_WINDOW_MS;
    }

    return WATCHER_ERROR_LOG_WINDOW_MS;
}

/**
 * Checks whether a watcher error is caused by OS-level watch descriptor limits.
 *
 * @param error Error raised by the active watcher backend.
 */
function isWatcherLimitError(error: unknown): boolean {
    const errorCode = readErrorCode(error);
    return errorCode === "EMFILE" || errorCode === "ENOSPC";
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

    log(`Replaying ${runtime.recoveredQueuePaths.length} queued file event(s) from disk.`);

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
            log(`${eventName} failed for ${absolutePath}: ${formatError(flushError)}. Retrying in ${retryDelayMs}ms.`);

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

    if (eventName !== "unlink" && isIgnored(runtime, absolutePath, false)) {
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
        if (eventName === "addDir") {
            await syncDirectory(runtime, absolutePath);
        }

        if (eventName === "unlinkDir" && runtime.config.deleteMissing) {
            await deleteDirectoryFromDestinations(runtime, absolutePath);
        }

        if (fullSyncDebounceMs !== undefined) {
            queueRuntimeFullSync(runtime, fullSyncDebounceMs, `Structural change detected (${eventName}).`);
        }
    } catch (error) {
        await appendOperationalErrorLog(runtime, `directory ${eventName}`, absolutePath, error);
        log(`${eventName} failed for ${absolutePath}: ${formatError(error)}`);
    }
}

/**
 * Ensures a source directory exists in every configured destination, replacing blocking files when needed.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteDirectoryPath Absolute path of the source directory to mirror.
 * @param shouldLogSyncOperation When true, logs the mirrored directory when something changed.
 */
async function syncDirectory(runtime: IJobRuntime, absoluteDirectoryPath: string, shouldLogSyncOperation: boolean = true): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absoluteDirectoryPath);
    let createdDestinationCount = 0;

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        const destinationStats = await readExistingPathStats(destinationPath);
        if (destinationStats && destinationStats.isDirectory()) {
            continue;
        }

        if (destinationStats) {
            await fs.remove(destinationPath);
        }

        await ensureDestinationParentDirectories(destination, relativePath);
        await fs.ensureDir(destinationPath);
        createdDestinationCount += 1;
    }

    if (shouldLogSyncOperation && createdDestinationCount > 0) {
        log(`Synced directory ${relativePath} to ${createdDestinationCount} destination(s).`);
    }
}

/**
 * Copies a source file to every configured destination while preserving timestamps.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteFilePath Absolute path of the source file to sync.
 * @param sourceFileState Optional source metadata already computed during a full reconciliation.
 * @param shouldSkipEquivalentDestinations When true, destinations deemed equivalent are left untouched.
 * @param shouldLogSyncOperation When true, logs the mirrored file when something changed.
 */
async function syncFile(runtime: IJobRuntime, absoluteFilePath: string, sourceFileState?: IFileState, shouldSkipEquivalentDestinations: boolean = false, shouldLogSyncOperation: boolean = true): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absoluteFilePath);
    let effectiveSourceFileState = sourceFileState;
    let copiedDestinationCount = 0;

    if (shouldSkipEquivalentDestinations && !effectiveSourceFileState) {
        effectiveSourceFileState = await readFileState(absoluteFilePath);
    }

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        const destinationStats = await readExistingPathStats(destinationPath);
        if (shouldSkipEquivalentDestinations && effectiveSourceFileState && destinationStats && destinationStats.isFile() && areFileStatesEquivalent(effectiveSourceFileState, toFileState(destinationStats))) {
            continue;
        }

        if (destinationStats && !destinationStats.isFile()) {
            await fs.remove(destinationPath);
        }

        await ensureDestinationParentDirectories(destination, relativePath);
        await fs.copy(absoluteFilePath, destinationPath, {
            overwrite: true,
            preserveTimestamps: true,
            errorOnExist: false
        });
        copiedDestinationCount += 1;
    }

    if (shouldLogSyncOperation && copiedDestinationCount > 0) {
        log(`Synced ${relativePath}`);
    }
}

/**
 * Ensures every parent segment for a mirrored destination file is a directory, replacing blocking files when needed.
 *
 * @param destinationRoot Absolute destination root.
 * @param relativeFilePath POSIX source-relative file path.
 */
async function ensureDestinationParentDirectories(destinationRoot: string, relativeFilePath: string): Promise<void> {
    const parentSegments = relativeFilePath.split("/").slice(0, -1);

    await fs.ensureDir(destinationRoot);

    let currentPath = destinationRoot;
    for (const segment of parentSegments) {
        currentPath = path.join(currentPath, segment);

        const currentStats = await readExistingPathStats(currentPath);
        if (currentStats && !currentStats.isDirectory()) {
            await fs.remove(currentPath);
        }

        await fs.ensureDir(currentPath);
    }
}

/**
 * Reads stats for a path and returns `undefined` when the path no longer exists or an ancestor is not a directory.
 *
 * @param absolutePath Absolute path to inspect.
 */
async function readExistingPathStats(absolutePath: string): Promise<Stats | undefined> {
    try {
        return await fs.stat(absolutePath);
    } catch (error) {
        if (isMissingPathError(error)) {
            return undefined;
        }

        throw error;
    }
}

/**
 * Converts a file stat object into the lightweight metadata used for sync comparisons.
 *
 * @param fileStats File stat object to normalize.
 */
function toFileState(fileStats: Stats): IFileState {
    return {
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs
    };
}

/**
 * Reads the comparison metadata for a file from disk.
 *
 * @param absolutePath Absolute file path to inspect.
 */
async function readFileState(absolutePath: string): Promise<IFileState> {
    return toFileState(await fs.stat(absolutePath));
}

/**
 * Checks whether two file states should be treated as equivalent during analysis and sync.
 *
 * @param sourceFileState Source file metadata.
 * @param destinationFileState Destination metadata.
 */
function areFileStatesEquivalent(sourceFileState: IFileState, destinationFileState: IFileState): boolean {
    return sourceFileState.size === destinationFileState.size && Math.abs(sourceFileState.mtimeMs - destinationFileState.mtimeMs) <= FILE_STATE_MTIME_TOLERANCE_MS;
}

/**
 * Removes a mirrored file from every configured destination.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteFilePath Absolute path of the source file that was removed.
 */
async function deleteFileFromDestinations(runtime: IJobRuntime, absoluteFilePath: string): Promise<void> {
    await deletePathFromDestinations(runtime, absoluteFilePath, "file");
}

/**
 * Removes a mirrored path from every configured destination.
 *
 * @param runtime Runtime state for the current job.
 * @param absolutePath Absolute path of the source entry that was removed.
 * @param sourceEntryType Optional source entry type used only for logging.
 */
async function deletePathFromDestinations(runtime: IJobRuntime, absolutePath: string, sourceEntryType?: SourceEntryType): Promise<void> {
    const relativePath = getRelativePathFromSource(runtime.config.source, absolutePath);

    for (const destination of runtime.config.destinations) {
        const destinationPath = resolveRelativePath(destination, relativePath);
        await fs.remove(destinationPath);
    }

    const label = sourceEntryType ?? "path";
    log(`Deleted ${label} ${relativePath}`);
}

/**
 * Removes a mirrored directory from every configured destination.
 *
 * @param runtime Runtime state for the current job.
 * @param absoluteDirectoryPath Absolute path of the source directory that was removed.
 */
async function deleteDirectoryFromDestinations(runtime: IJobRuntime, absoluteDirectoryPath: string): Promise<void> {
    await deletePathFromDestinations(runtime, absoluteDirectoryPath, "directory");
}

/**
 * Ensures that the reserved operational directory and its files exist inside the source root.
 *
 * @param runtime Runtime state for the current job.
 */
async function ensureOperationalStateDirectory(runtime: IJobRuntime): Promise<void> {
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
    const entry = `[${new Date().toISOString()}] ${scope} ${targetPath}: ${formatError(error)}\n`;

    try {
        await ensureOperationalStateDirectory(runtime);
        await fs.appendFile(runtime.errorLogPath, entry, "utf8");
    } catch (writeError) {
        console.error(`[${new Date().toISOString()}] Failed to write ${runtime.errorLogPath}: ${formatError(writeError)}`);
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

    return relativeToSource.split("/").includes(INTERNAL_APP_DIRECTORY_NAME);
}

/**
 * Checks whether a source path should exist in a mirrored destination after applying hidden and ignore rules.
 *
 * @param runtime Runtime state for the current job.
 * @param absolutePath Absolute source path to evaluate.
 * @param isDirectory Whether the path should be evaluated as a directory candidate.
 */
function shouldMirrorSourcePath(runtime: IJobRuntime, absolutePath: string, isDirectory: boolean = false): boolean {
    if (path.basename(absolutePath) === IGNORE_FILE_NAME || isOperationalPath(runtime.config.source, absolutePath)) {
        return false;
    }

    if (!runtime.config.watchHidden && isHiddenPath(runtime.config.source, absolutePath)) {
        return false;
    }

    return !isIgnored(runtime, absolutePath, isDirectory);
}

/**
 * Reads the effective mirrored type for a source path after ignore rules and filesystem existence are applied.
 *
 * @param runtime Runtime state for the current job.
 * @param absolutePath Absolute source path to inspect.
 */
async function readMirrorableSourceEntryType(runtime: IJobRuntime, absolutePath: string): Promise<SourceEntryType | undefined> {
    const sourceStats = await readExistingPathStats(absolutePath);
    if (!sourceStats) {
        return undefined;
    }

    if (!shouldMirrorSourcePath(runtime, absolutePath, sourceStats.isDirectory())) {
        return undefined;
    }

    if (sourceStats.isDirectory()) {
        return "directory";
    }

    if (sourceStats.isFile()) {
        return "file";
    }

    return undefined;
}

/**
 * Executes an ignore matcher against both file and directory candidates.
 *
 * @param matcher Ignore matcher instance.
 * @param candidate Source-relative candidate path.
 * @param isDirectory Whether the candidate should be evaluated as a directory.
 */
function testIgnoreMatcher(matcher: ReturnType<typeof ignore>, candidate: string, isDirectory: boolean = false): { ignored: boolean; unignored: boolean } {
    const effectiveCandidate = isDirectory && !candidate.endsWith("/") ? `${candidate}/` : candidate;
    const result = matcher.test(effectiveCandidate);

    return {
        ignored: result.ignored,
        unignored: result.unignored
    };
}

/**
 * Checks whether an existing path currently points to a directory.
 *
 * @param absolutePath Absolute path to inspect.
 */
function isExistingDirectoryPath(absolutePath: string): boolean {
    try {
        return fs.statSync(absolutePath).isDirectory();
    } catch {
        return false;
    }
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
 * Reads an optional non-empty string and returns `undefined` when the value is missing or blank.
 *
 * @param value Parsed field value.
 */
function readOptionalNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
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
 * Checks whether a parsed value is a non-negative integer.
 *
 * @param value Parsed value to validate.
 */
function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0;
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
        let startedFullSync = false;

        try {
            if (shouldReloadIgnoreFiles) {
                await reloadIgnoreFiles(runtime);
            }

            log(`${reason} Running reconciliation.`);
            startedFullSync = true;
            await runFullSync(runtime, "Full sync");
        } catch (error) {
            if (!startedFullSync) {
                await appendOperationalErrorLog(runtime, "full sync", runtime.config.source, error);
            }
            log(`Full sync failed: ${formatError(error)}`);
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
    console.log(`[${timestamp}] ${message}`);
    scheduleManagedStdoutLogMaintenance();
}

/**
 * Registers a stdout log path that should be trimmed when it grows too large.
 *
 * @param logPath Absolute path of the managed stdout log file.
 */
function registerManagedStdoutLogPath(logPath: string): void {
    managedStdoutLogPaths.add(logPath);
}

/**
 * Schedules maintenance for managed stdout log files so they do not grow without bounds.
 */
function scheduleManagedStdoutLogMaintenance(): void {
    if (managedStdoutLogPaths.size === 0) {
        return;
    }

    const now = Date.now();
    if (now - lastManagedStdoutLogMaintenanceAtMs < MANAGED_STDOUT_LOG_MAINTENANCE_WINDOW_MS) {
        return;
    }

    lastManagedStdoutLogMaintenanceAtMs = now;
    managedStdoutLogMaintenancePromise = managedStdoutLogMaintenancePromise
        .then(async () => {
            for (const logPath of managedStdoutLogPaths) {
                await trimManagedStdoutLogFile(logPath);
            }
        })
        .catch((error) => {
            console.error(`[${new Date().toISOString()}] Failed to maintain managed stdout logs: ${formatError(error)}`);
        });
}

/**
 * Keeps only the most recent portion of a managed stdout log when it exceeds the configured size limit.
 *
 * @param logPath Absolute path of the managed stdout log file.
 */
async function trimManagedStdoutLogFile(logPath: string): Promise<void> {
    let logStats: Stats;

    try {
        logStats = await fs.stat(logPath);
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }

        throw error;
    }

    if (!logStats.isFile() || logStats.size <= MAX_MANAGED_STDOUT_LOG_SIZE_BYTES) {
        return;
    }

    const bytesToRetain = Math.min(RETAINED_MANAGED_STDOUT_LOG_SIZE_BYTES, logStats.size);
    const readOffset = logStats.size - bytesToRetain;
    const fileHandle = await open(logPath, "r");
    const retainedBuffer = Buffer.alloc(bytesToRetain);
    let retainedContent = "";

    try {
        const { bytesRead } = await fileHandle.read(retainedBuffer, 0, bytesToRetain, readOffset);
        retainedContent = retainedBuffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await fileHandle.close();
    }

    const firstLineBreakIndex = retainedContent.indexOf("\n");
    const normalizedRetainedContent = firstLineBreakIndex >= 0 ? retainedContent.slice(firstLineBreakIndex + 1) : retainedContent;
    const truncatedContent = `[${new Date().toISOString()}] launchd.log truncated after exceeding ${formatBytes(logStats.size)}.\n${normalizedRetainedContent}`;
    await fs.writeFile(logPath, truncatedContent, "utf8");
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

/**
 * Extracts a string error code from an unknown runtime error.
 *
 * @param error Error value thrown by the runtime.
 */
function readErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }

    const candidateCode = (error as { code?: unknown }).code;
    return typeof candidateCode === "string" ? candidateCode : undefined;
}

/**
 * Checks whether an error means a filesystem path is effectively missing for traversal purposes.
 *
 * @param error Error value thrown by the runtime.
 */
function isMissingPathError(error: unknown): boolean {
    const errorCode = readErrorCode(error);
    return errorCode === "ENOENT" || errorCode === "ENOTDIR";
}

const isDirectExecution = typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isDirectExecution) {
    main().catch((error) => {
        console.error(formatError(error));
        process.exitCode = 1;
    });
}

export { analyzeRuntime, appendOperationalErrorLog, buildWatchmanSubscribeCommand, createInstalledLauncherContent, createInstallPaths, createPathExportBlock, createRuntime, createSourceFolderSlug, flushQueuedFileEvent, getConfigPath, getRetryDelayMs, handleDirectoryEvent, handleFileEvent, installGlobalCli, isHiddenPath, isIgnored, isPathInsideSource, isWatcherLimitError, main, normalizeWatchmanEntryType, parseCliArguments, parseSetupArguments, queueFileEvent, readConfig, readErrorCode, reconcileRuntimes, reloadIgnoreFiles, renderInstallConfigContent, renderLaunchAgentTemplate, resolveConfiguredPath, runFullSync, runInitialSync, setupMirror, shouldLogWatcherError, startWatcher, syncFile };
