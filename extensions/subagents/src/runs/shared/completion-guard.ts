import type { Message } from "@earendil-works/pi-ai";
import { isMutatingBashCommand } from "./long-running-guard.ts";
import { expectsImplementationMutation as sharedExpectsImplementationMutation } from "./task-intent.ts";

const VALIDATION_ONLY_TASK_PATTERNS = [
	/\bfinal(?:[-\s]+)?validation\b/i,
	/\bvalidat(?:e|ion|ing)\b/i,
	/\bverif(?:y|ication)\b/i,
];

const CONDITIONAL_NO_SOURCE_CHANGE_PATTERNS = [
	/\bdo not make\s+(?:any\s+)?(?:source|code)\s+changes?\s+unless\b/i,
	/\bdo not (?:modify|change)\s+(?:the\s+)?(?:source|code)\s+unless\b/i,
];

const VALIDATION_CONDITIONAL_MUTATION_PATTERNS = [
	/\bunless\b[\s\S]{0,160}\b(?:validation|tests?|checks?|verif(?:y|ication)|fail(?:ed|ing|s|ure|ures)?|issues?)\b[\s\S]{0,120}\b(?:expose|exposes|exposed|find|finds|found|reveal|reveals|revealed|show|shows|showed|surface|surfaces|surfaced|fail(?:ed|ing|s|ure|ures)?|issue|issues)\b/i,
];

const NON_SOURCE_EDIT_TARGET_PATTERNS = [
	/\breadme\b/i,
	/\bdocs?\b/i,
	/\bdocumentation\b/i,
	/\bchangelog\b/i,
	/\bpackage(?:\.json)?\b/i,
	/\bmanifest\b/i,
	/\bconfig(?:uration)?\b/i,
];

const NON_SOURCE_EDIT_REQUEST_PATTERNS = [
	/\b(?:update|add|remove|replace|create|edit|modify|change|patch)\b[^\n.;:!?]{0,80}\b(?:readme|docs?|documentation|changelog|package(?:\.json)?|manifest|config(?:uration)?)\b/i,
	/(?:^|[\n.;:!?]\s*|\band\s+)(?:please\s+)?fix\b[^\n.;:!?]{0,20}\b(?:readme|docs?|documentation|changelog|package(?:\.json)?|manifest|config(?:uration)?)\b/i,
];

const READ_ONLY_BUILTIN_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
	"intercom",
	"contact_supervisor",
]);

interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	tools?: string[];
	mcpDirectTools?: string[];
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
}

type ToolMutationCapability = { kind: "mutation-capable" } | { kind: "read-only" };

function toolMutationCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): ToolMutationCapability {
	if (tools === undefined || tools.length === 0 || (mcpDirectTools?.length ?? 0) > 0) return { kind: "mutation-capable" };
	return tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool)) ? { kind: "read-only" } : { kind: "mutation-capable" };
}

function isConditionalValidationNoSourceChangeTask(task: string): boolean {
	return VALIDATION_ONLY_TASK_PATTERNS.some((pattern) => pattern.test(task))
		&& CONDITIONAL_NO_SOURCE_CHANGE_PATTERNS.some((pattern) => pattern.test(task))
		&& VALIDATION_CONDITIONAL_MUTATION_PATTERNS.some((pattern) => pattern.test(task));
}

function hasExplicitNonSourceEditRequest(task: string): boolean {
	return NON_SOURCE_EDIT_TARGET_PATTERNS.some((pattern) => pattern.test(task))
		&& NON_SOURCE_EDIT_REQUEST_PATTERNS.some((pattern) => pattern.test(task));
}

function localAgentName(agent: string): string {
	const lastDot = agent.lastIndexOf(".");
	return lastDot === -1 ? agent : agent.slice(lastDot + 1);
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	if (isConditionalValidationNoSourceChangeTask(task)
		&& !hasExplicitNonSourceEditRequest(task)) return false;
	return sharedExpectsImplementationMutation(localAgentName(agent), task);
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "edit" || part.name === "write") return true;
			if (part.name !== "bash") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (typeof args.command === "string" && isMutatingBashCommand(args.command)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = toolMutationCapability(input.tools, input.mcpDirectTools).kind === "read-only"
		? false
		: expectsImplementationMutation(input.agent, input.task);
	const attemptedMutation = hasMutationToolCall(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation,
	};
}
