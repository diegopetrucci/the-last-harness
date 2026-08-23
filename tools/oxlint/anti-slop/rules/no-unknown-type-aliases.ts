import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, Variable } from "@oxlint/plugins";

function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

type ScopeKey = Scope | NamespaceScopeKey;
type NamespaceScopeKey = {
  parent: ScopeKey;
  name: string;
};

function isNamespaceScopeKey(key: ScopeKey): key is NamespaceScopeKey {
  return "parent" in key;
}

type AliasBinding = {
  declaration: ESTree.TSTypeAliasDeclaration;
  scope: Scope;
};

function hasTypeNamespaceDefinition(variable: Variable): boolean {
  return variable.defs.some(({ node }) => {
    switch (node.type) {
      case "ClassDeclaration":
      case "TSEnumDeclaration":
      case "TSInterfaceDeclaration":
      case "TSImportEqualsDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSTypeParameter":
        return true;
      default:
        return false;
    }
  });
}

function isAmbientNamespaceScope(scope: Scope): boolean {
  let current: Scope | null = scope;
  while (current !== null) {
    if (current.block.type === "TSModuleDeclaration" && current.block.declare) return true;
    current = current.upper;
  }
  return false;
}

type NamespaceNamePart = {
  kind: "identifier" | "string";
  value: string;
};

function namespaceNameParts(id: ESTree.TSModuleDeclaration["id"]): NamespaceNamePart[] {
  if (id.type === "TSQualifiedName") {
    const left =
      id.left.type === "TSQualifiedName"
        ? namespaceNameParts(id.left)
        : id.left.type === "Identifier"
          ? [{ kind: "identifier" as const, value: id.left.name }]
          : [];
    return [...left, { kind: "identifier", value: id.right.name }];
  }
  if (id.type === "Literal") return [{ kind: "string", value: id.value }];
  return [{ kind: "identifier", value: id.name }];
}

function isExportedTypeNamespaceDefinition(variable: Variable, scope: Scope): boolean {
  if (isAmbientNamespaceScope(scope)) return true;
  return variable.defs.some(({ node }) => node.parent?.type === "ExportNamedDeclaration");
}

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
    const aliasesByScope = new Map<Scope, Map<string, AliasBinding>>();
    const exportedAliasesByNamespace = new Map<NamespaceScopeKey, Map<string, AliasBinding>>();
    const exportedTypeNamespaceShadowsByNamespace = new Map<NamespaceScopeKey, Set<string>>();
    const shadowedNamesByScope = new Map<Scope, Set<string>>();
    const aliases: AliasBinding[] = [];
    const namespaceKeysByScope = new Map<Scope, NamespaceScopeKey>();
    const namespaceKeysByParent = new Map<ScopeKey, Map<string, NamespaceScopeKey>>();

    function scopeKeyFor(scope: Scope): ScopeKey {
      return namespaceScopeKeyFor(scope) ?? scope;
    }

    function namespaceScopeKeyFor(scope: Scope): NamespaceScopeKey | null {
      const cached = namespaceKeysByScope.get(scope);
      if (cached !== undefined) return cached;
      if (scope.block.type !== "TSModuleDeclaration" || scope.upper === null) return null;

      let parent = scopeKeyFor(scope.upper);
      let key: NamespaceScopeKey | undefined;
      for (const part of namespaceNameParts(scope.block.id)) {
        const name = `${part.kind}:${part.value}`;
        let names = namespaceKeysByParent.get(parent);
        if (names === undefined) {
          names = new Map();
          namespaceKeysByParent.set(parent, names);
        }
        key = names.get(name);
        if (key === undefined) {
          key = { parent, name };
          names.set(name, key);
        }
        parent = key;
      }
      if (key === undefined) return null;
      namespaceKeysByScope.set(scope, key);
      return key;
    }

    const resolveCanonicalParentNamespaceMember = (
      scope: Scope,
      name: string,
    ): AliasBinding | null | undefined => {
      if (scope.block.type !== "TSModuleDeclaration" || scope.block.id.type !== "TSQualifiedName")
        return undefined;

      const namespaceKey = namespaceScopeKeyFor(scope);
      if (namespaceKey === null) return undefined;

      let parent = namespaceKey.parent;
      let syntheticParentCount = namespaceNameParts(scope.block.id).length - 1;
      while (syntheticParentCount > 0 && isNamespaceScopeKey(parent)) {
        const exportedAlias = exportedAliasesByNamespace.get(parent)?.get(name);
        if (exportedAlias !== undefined) return exportedAlias;
        if (exportedTypeNamespaceShadowsByNamespace.get(parent)?.has(name)) return null;
        parent = parent.parent;
        syntheticParentCount -= 1;
      }
      return undefined;
    };

    const resolveAlias = (scope: Scope, name: string): AliasBinding | null => {
      let current: Scope | null = scope;
      while (current !== null) {
        const alias = aliasesByScope.get(current)?.get(name);
        if (alias !== undefined) return alias;
        if (shadowedNamesByScope.get(current)?.has(name)) return null;
        const namespaceKey = namespaceScopeKeyFor(current);
        if (namespaceKey !== null) {
          const exportedAlias = exportedAliasesByNamespace.get(namespaceKey)?.get(name);
          if (exportedAlias !== undefined) return exportedAlias;
          if (exportedTypeNamespaceShadowsByNamespace.get(namespaceKey)?.has(name)) return null;
          const parentMember = resolveCanonicalParentNamespaceMember(current, name);
          if (parentMember !== undefined) return parentMember;
        }
        current = current.upper;
      }
      return null;
    };

    const collectTypeNamespaceShadows = () => {
      shadowedNamesByScope.clear();
      exportedTypeNamespaceShadowsByNamespace.clear();
      for (const scope of context.sourceCode.scopeManager.scopes) {
        const namespaceKey = namespaceScopeKeyFor(scope);
        for (const variable of scope.variables) {
          if (!hasTypeNamespaceDefinition(variable)) continue;
          let names = shadowedNamesByScope.get(scope);
          if (names === undefined) {
            names = new Set();
            shadowedNamesByScope.set(scope, names);
          }
          names.add(variable.name);

          if (namespaceKey === null || !isExportedTypeNamespaceDefinition(variable, scope))
            continue;
          let exportedNames = exportedTypeNamespaceShadowsByNamespace.get(namespaceKey);
          if (exportedNames === undefined) {
            exportedNames = new Set();
            exportedTypeNamespaceShadowsByNamespace.set(namespaceKey, exportedNames);
          }
          exportedNames.add(variable.name);
        }
      }
    };

    const resolvesToUnknown = (
      type: ESTree.TSType,
      scope: Scope,
      visited = new Set<AliasBinding>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, scope, visited);
      }
      const name = referencedAliasName(type);
      if (name === null) return false;
      const alias = resolveAlias(scope, name);
      if (
        alias === null ||
        visited.has(alias) ||
        (alias.declaration.typeParameters !== null &&
          alias.declaration.typeParameters !== undefined)
      ) {
        return false;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(alias);
      return resolvesToUnknown(alias.declaration.typeAnnotation, alias.scope, nextVisited);
    };

    const clearAliases = () => {
      aliasesByScope.clear();
      exportedAliasesByNamespace.clear();
      exportedTypeNamespaceShadowsByNamespace.clear();
      shadowedNamesByScope.clear();
      aliases.length = 0;
      namespaceKeysByScope.clear();
      namespaceKeysByParent.clear();
    };

    const collectAlias = (declaration: ESTree.TSTypeAliasDeclaration) => {
      const scope = context.sourceCode.getScope(declaration);
      const alias = { declaration, scope };
      let scopeAliases = aliasesByScope.get(scope);
      if (scopeAliases === undefined) {
        scopeAliases = new Map();
        aliasesByScope.set(scope, scopeAliases);
      }
      scopeAliases.set(declaration.id.name, alias);

      const namespaceKey = namespaceScopeKeyFor(scope);
      if (
        namespaceKey !== null &&
        (declaration.parent.type === "ExportNamedDeclaration" || isAmbientNamespaceScope(scope))
      ) {
        let exportedAliases = exportedAliasesByNamespace.get(namespaceKey);
        if (exportedAliases === undefined) {
          exportedAliases = new Map();
          exportedAliasesByNamespace.set(namespaceKey, exportedAliases);
        }
        exportedAliases.set(declaration.id.name, alias);
      }
      aliases.push(alias);
    };

    return {
      Program: clearAliases,
      TSTypeAliasDeclaration: collectAlias,
      "Program:exit"() {
        collectTypeNamespaceShadows();
        for (const alias of aliases) {
          if (!resolvesToUnknown(alias.declaration.typeAnnotation, alias.scope, new Set([alias])))
            continue;
          context.report({
            node: alias.declaration.id,
            messageId: "unknownAlias",
            data: { alias: alias.declaration.id.name },
          });
        }
      },
    };
  },
});
