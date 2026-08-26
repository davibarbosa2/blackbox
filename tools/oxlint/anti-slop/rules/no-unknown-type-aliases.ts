import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	createLexicalTypeAliases,
	type LexicalTypeAliases,
} from "../shared/lexical-type-aliases.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
		},
	},
	createOnce(context) {
		let aliases: LexicalTypeAliases | null = null;

		const resolvesToUnknown = (
			type: ESTree.TSType,
			visited = new Set<ESTree.TSTypeAliasDeclaration>(),
		): boolean => {
			if (type.type === "TSUnknownKeyword") return true;
			if (type.type === "TSParenthesizedType")
				return resolvesToUnknown(type.typeAnnotation, visited);
			if (type.type === "TSUnionType") {
				return type.types.some((member) => resolvesToUnknown(member, visited));
			}
			if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
				return false;
			}
			const alias = aliases?.resolve(type.typeName.name, type);
			if (
				alias === undefined ||
				visited.has(alias) ||
				(alias.typeParameters !== null && alias.typeParameters !== undefined) ||
				(type.typeArguments !== null &&
					type.typeArguments !== undefined &&
					type.typeArguments.params.length > 0)
			) {
				return false;
			}
			const nextVisited = new Set(visited);
			nextVisited.add(alias);
			return resolvesToUnknown(alias.typeAnnotation, nextVisited);
		};

		return {
			Program(node) {
				aliases = createLexicalTypeAliases(node, context.sourceCode.visitorKeys);
				for (const alias of aliases.declarations) {
					if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias]))) continue;
					context.report({
						node: alias.id,
						messageId: "unknownAlias",
						data: { alias: alias.id.name },
					});
				}
			},
		};
	},
});
