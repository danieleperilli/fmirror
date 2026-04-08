/**
 * fmirror (File Mirror)
 * 
 * A small TypeScript/Node.js utility that watches one or more source folders and mirrors them to one or more destination folders.
 * 
 * Copyright (c) 2026 Daniele Perilli
 */

import ignore from "ignore";

export interface IAppConfig {
    debounceMs?: number;
    fileDebounceMs?: number;
    jobs: IJobConfig[];
}

export interface IJobConfig {
    name: string;
    source: string;
    destinations: string[];
    deleteMissing?: boolean;
    watchHidden?: boolean;
}

export interface IIgnoreFile {
    directory: string;
    matcher: ReturnType<typeof ignore>;
}

export type FileEventName = "add" | "change" | "unlink";

export interface IQueuedFileEvent {
    eventName: FileEventName;
    debounceTimer?: NodeJS.Timeout;
    retryTimer?: NodeJS.Timeout;
    missingSinceAtMs?: number;
    isProcessing: boolean;
    runAfterCurrent: boolean;
    retryCount: number;
}

export interface IQueuedDirectoryDelete {
    debounceTimer?: NodeJS.Timeout;
    missingSinceAtMs?: number;
    fullSyncDebounceMs?: number;
    fullSyncReason?: string;
}

export interface IQueuedFullSyncRequest {
    debounceMs: number;
    reason: string;
    shouldReloadIgnoreFiles: boolean;
    shouldRefreshWatcher: boolean;
}

export interface IPersistedQueueItem {
    path: string;
    eventName: FileEventName;
}

export interface IPersistedQueueState {
    version: number;
    updatedAt: string;
    items: IPersistedQueueItem[];
}

export interface IJobRuntime {
    config: INormalizedJobConfig;
    ignoreFiles: IIgnoreFile[];
    internalAppDirectory: string;
    errorLogPath: string;
    queueFilePath: string;
    fileEventDebounceMs: number;
    queuedFileEvents: Map<string, IQueuedFileEvent>;
    queuedDirectoryDeletes: Map<string, IQueuedDirectoryDelete>;
    recoveredQueuePaths: string[];
    queuePersistencePromise: Promise<void>;
    fileEventBurstCount: number;
    watcherErrorState?: IWatcherErrorState;
    watcher?: IWatchSession;
    queuedFullSyncRequest?: IQueuedFullSyncRequest;
    isFullSyncRunning?: boolean;
    fullSyncTimer?: NodeJS.Timeout;
    fileEventBurstTimer?: NodeJS.Timeout;
}

export interface IWatchSession {
    close(): Promise<void>;
}

export interface INormalizedJobConfig {
    name: string;
    source: string;
    destinations: string[];
    deleteMissing: boolean;
    watchHidden: boolean;
}

export interface IFileState {
    size: number;
    mtimeMs: number;
}

export type CliCommandName = "watch" | "analyze" | "reconcile" | "install" | "setup";

export interface ICliArguments {
    command: CliCommandName;
    configPath?: string;
    fastStart: boolean;
}

export interface IRuntimeAnalysis {
    fileCount: number;
    totalSizeBytes: number;
    logPath: string;
    destinationAnalyses: IDestinationAnalysis[];
}

export interface IWatcherErrorState {
    key: string;
    message: string;
    suppressedCount: number;
    lastLoggedAt: number;
}

export interface IDestinationAnalysis {
    path: string;
    fileCount: number;
    totalSizeBytes: number;
    missingFileCount: number;
    outdatedFileCount: number;
    extraFileCount: number;
}
