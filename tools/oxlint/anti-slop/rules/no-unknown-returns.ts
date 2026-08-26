import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  createLexicalTypeAliases,
  type LexicalTypeAliases,
} from "../shared/lexical-type-aliases.ts";
import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    let aliases: LexicalTypeAliases | null = null;

    const resolvesToUnknown = (
      type: ESTree.TSType,
      visited = new Set<ESTree.TSTypeAliasDeclaration>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, visited);
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) => resolvesToUnknown(member, visited));
      }
      if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
        return false;
      }
      const name = type.typeName.name;
      const alias = aliases?.resolve(name, type);
      if (alias !== undefined) {
        if (
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
      }
      if (lexicalTypeParameterNames(type, context.sourceCode.visitorKeys).has(name)) {
        return false;
      }
      if (name !== "Promise" && name !== "PromiseLike") return false;
      const value = type.typeArguments?.params[0];
      return value !== undefined && resolvesToUnknown(value, visited);
    };

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        aliases = createLexicalTypeAliases(node, context.sourceCode.visitorKeys);
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
