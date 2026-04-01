/**
 * fmirror (File Mirror)
 *
 * A small TypeScript/Node.js utility that watches one or more source folders and mirrors them to one or more destination folders.
 *
 * Copyright (c) 2026 Daniele Perilli
 */
import { build as runEsbuild } from "esbuild";
import fs from "fs-extra";
import path from "node:path";

interface IPackageMetadata {
    name?: unknown;
    version?: unknown;
}

const OUTPUT_DIRECTORY_PATH = path.resolve(process.cwd(), "dist");
const ENTRY_POINT_PATH = path.resolve(process.cwd(), "src", "index.ts");
const OUTPUT_BUNDLE_PATH = path.join(OUTPUT_DIRECTORY_PATH, "fmirror.js");
const PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");

/**
 * Builds the distributable bundle.
 */
async function build(): Promise<void> {
    const packageMetadata = await readPackageMetadata();
    const banner = createBannerComment(packageMetadata);

    await runEsbuild({
        entryPoints: [
            ENTRY_POINT_PATH
        ],
        outfile: OUTPUT_BUNDLE_PATH,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        banner: {
            js: banner
        }
    });
}

/**
 * Reads and validates the minimal package metadata required for the build banner.
 */
async function readPackageMetadata(): Promise<{ name: string; version: string }> {
    const packageMetadata = await fs.readJson(PACKAGE_JSON_PATH) as IPackageMetadata;

    if (typeof packageMetadata.name !== "string" || !packageMetadata.name.trim()) {
        throw new Error("package.json must contain a non-empty name.");
    }

    if (typeof packageMetadata.version !== "string" || !packageMetadata.version.trim()) {
        throw new Error("package.json must contain a non-empty version.");
    }

    return {
        name: packageMetadata.name.trim(),
        version: packageMetadata.version.trim()
    };
}

/**
 * Creates the banner comment that is prepended to the generated bundle.
 *
 * @param packageMetadata Validated package metadata used in the banner.
 */
function createBannerComment(packageMetadata: { name: string; version: string }): string {
    return [
        "/**",
        ` * ${packageMetadata.name} v${packageMetadata.version}`,
        ` * Copyright (c) 2026 Daniele Perilli`,
        " */"
    ].join("\n");
}

build().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
