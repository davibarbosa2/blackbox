import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "./lexical-type-parameters.ts";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export interface LexicalTypeAliases {
	declarations: readonly ESTree.TSTypeAliasDeclaration[];
	resolve(
		name: string,
		reference: ESTree.Node,
	): ESTree.TSTypeAliasDeclaration | undefined;
}

function isNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function isAliasScope(node: ESTree.Node): boolean {
	return (
		node.type === "BlockStatement" ||
		node.type === "Program" ||
		node.type === "StaticBlock" ||
		node.type === "SwitchStatement" ||
		node.type === "TSModuleBlock"
	);
}

function enclosingAliasScope(node: ESTree.Node): ESTree.Node | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null) {
		if (isAliasScope(current)) return current;
		current = current.parent;
	}
	return null;
}

/** Index type aliases by lexical statement scope and resolve the nearest visible declaration. */
export function createLexicalTypeAliases(
	program: ESTree.Program,
	visitorKeys: VisitorKeys,
): LexicalTypeAliases {
	const declarations: ESTree.TSTypeAliasDeclaration[] = [];
	const aliasesByScope = new Map<
		ESTree.Node,
		Map<string, ESTree.TSTypeAliasDeclaration>
	>();

	const visit = (node: ESTree.Node): void => {
		if (node.type === "TSTypeAliasDeclaration") {
			declarations.push(node);
			const scope = enclosingAliasScope(node);
			if (scope !== null) {
				const aliases = aliasesByScope.get(scope) ?? new Map();
				aliases.set(node.id.name, node);
				aliasesByScope.set(scope, aliases);
			}
		}

		const record = node as unknown as Readonly<Record<string, unknown>>;
		for (const key of visitorKeys[node.type] ?? []) {
			const value = record[key];
			if (isNode(value)) {
				visit(value);
				continue;
			}
			if (!Array.isArray(value)) continue;
			for (const child of value) {
				if (isNode(child)) visit(child);
			}
		}
	};

	visit(program);

	return {
		declarations,
		resolve(name, reference) {
			if (lexicalTypeParameterNames(reference, visitorKeys).has(name)) {
				return undefined;
			}
			let current: ESTree.Node | null = reference;
			while (current !== null) {
				const alias = aliasesByScope.get(current)?.get(name);
				if (alias !== undefined) return alias;
				current = current.parent;
			}
			return undefined;
		},
	};
}
