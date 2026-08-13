import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LOCALES_ROOT = fileURLToPath(
	new URL("../src/i18n/locales/", import.meta.url),
);

function listNamespaceFiles(locale: string): string[] {
	return readdirSync(join(LOCALES_ROOT, locale))
		.filter((name) => name.endsWith(".json"))
		.sort();
}

/** Nested object key paths (`a.b.c`), including intermediate objects. */
function collectKeyPaths(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return prefix ? [prefix] : [];
	}
	const paths: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		paths.push(path);
		if (child !== null && typeof child === "object" && !Array.isArray(child)) {
			paths.push(...collectKeyPaths(child, path));
		}
	}
	return paths;
}

function loadNamespace(locale: string, file: string): unknown {
	const raw = readFileSync(join(LOCALES_ROOT, locale, file), "utf8");
	return JSON.parse(raw) as unknown;
}

function diffSorted(
	left: string[],
	right: string[],
): {
	onlyLeft: string[];
	onlyRight: string[];
} {
	const rightSet = new Set(right);
	const leftSet = new Set(left);
	return {
		onlyLeft: left.filter((key) => !rightSet.has(key)),
		onlyRight: right.filter((key) => !leftSet.has(key)),
	};
}

describe("i18n locale parity", () => {
	const enFiles = listNamespaceFiles("en");
	const zhFiles = listNamespaceFiles("zh-CN");

	it("has the same namespace files in en and zh-CN", () => {
		const { onlyLeft: onlyEn, onlyRight: onlyZh } = diffSorted(
			enFiles,
			zhFiles,
		);
		expect(onlyEn, `only in en: [${onlyEn.join(", ")}]`).toEqual([]);
		expect(onlyZh, `only in zh-CN: [${onlyZh.join(", ")}]`).toEqual([]);
	});

	for (const file of enFiles) {
		it(`${file} key sets match in en and zh-CN`, () => {
			expect(zhFiles, `zh-CN is missing namespace file ${file}`).toContain(
				file,
			);
			const enKeys = collectKeyPaths(loadNamespace("en", file)).sort();
			const zhKeys = collectKeyPaths(loadNamespace("zh-CN", file)).sort();
			const { onlyLeft: missingInZh, onlyRight: extraInZh } = diffSorted(
				enKeys,
				zhKeys,
			);
			expect(
				missingInZh,
				`${file} missing in zh-CN: [${missingInZh.join(", ")}]`,
			).toEqual([]);
			expect(
				extraInZh,
				`${file} extra in zh-CN: [${extraInZh.join(", ")}]`,
			).toEqual([]);
		});
	}

	for (const file of zhFiles.filter((name) => !enFiles.includes(name))) {
		it(`en is missing namespace file ${file}`, () => {
			expect(enFiles).toContain(file);
		});
	}
});
