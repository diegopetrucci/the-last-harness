import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import {
  SLASH_SUBAGENT_CANCEL_EVENT,
  SLASH_SUBAGENT_REQUEST_EVENT,
  SLASH_SUBAGENT_RESPONSE_EVENT,
  SLASH_SUBAGENT_STARTED_EVENT,
  SLASH_SUBAGENT_UPDATE_EVENT,
  type Details,
  type SubagentToolResult,
} from "../shared/types.ts";

export type AllowedSlashSubagentParams = { action: "doctor" } | { action: "status"; view: "fleet" };

interface SlashSubagentRequest {
  requestId: string;
  params: AllowedSlashSubagentParams;
  /** Optional requester context for in-process extension bridge calls. */
  ctx?: ExtensionContext;
}

const INVALID_SLASH_REQUEST_TEXT = "Unsupported slash subagent request.";

/**
 * Private first-party boundary: retained slash commands emit only these exact
 * read-only parameter shapes before reaching the executor.
 */
function resolveAllowedSlashSubagentParams(value: unknown): AllowedSlashSubagentParams | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;

    const keys = Reflect.ownKeys(value);
    if (keys.length === 1 && keys[0] === "action") {
      const action = Object.getOwnPropertyDescriptor(value, "action");
      return action?.enumerable && "value" in action && action.value === "doctor"
        ? { action: "doctor" }
        : undefined;
    }
    if (keys.length !== 2 || !keys.includes("action") || !keys.includes("view")) return undefined;
    const action = Object.getOwnPropertyDescriptor(value, "action");
    const view = Object.getOwnPropertyDescriptor(value, "view");
    return action?.enumerable &&
      "value" in action &&
      action.value === "status" &&
      view?.enumerable &&
      "value" in view &&
      view.value === "fleet"
      ? { action: "status", view: "fleet" }
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidSlashSubagentResponse(requestId: string): SlashSubagentResponse {
  return {
    requestId,
    result: {
      content: [{ type: "text", text: INVALID_SLASH_REQUEST_TEXT }],
      details: { mode: "single" as const, results: [] },
    },
    isError: true,
    errorText: INVALID_SLASH_REQUEST_TEXT,
  };
}

export interface SlashSubagentResponse {
  requestId: string;
  result: SubagentToolResult<Details>;
  isError: boolean;
  errorText?: string;
}

export interface SlashSubagentUpdate {
  requestId: string;
  progress?: Details["progress"];
  currentTool?: string;
  toolCount?: number;
}

interface EventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

interface SlashBridgeOptions {
  events: EventBus;
  getContext: () => ExtensionContext | null;
  execute: (
    id: string,
    params: SubagentParamsLike,
    signal: AbortSignal,
    onUpdate: ((r: SubagentToolResult<Details>) => void) | undefined,
    ctx: ExtensionContext,
  ) => Promise<SubagentToolResult<Details>>;
}

export function registerSlashSubagentBridge(options: SlashBridgeOptions): {
  cancelAll: () => void;
  dispose: () => void;
} {
  const controllers = new Map<string, AbortController>();
  const pendingCancels = new Set<string>();
  const subscriptions: Array<() => void> = [];

  const subscribe = (event: string, handler: (data: unknown) => void): void => {
    const unsubscribe = options.events.on(event, handler);
    if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
  };

  const rejectRequest = (requestId: string): void => {
    pendingCancels.delete(requestId);
    options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, invalidSlashSubagentResponse(requestId));
  };

  subscribe(SLASH_SUBAGENT_CANCEL_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    const controller = controllers.get(requestId);
    if (controller) {
      controller.abort();
      return;
    }
    pendingCancels.add(requestId);
  });

  subscribe(SLASH_SUBAGENT_REQUEST_EVENT, async (data) => {
    if (!data || typeof data !== "object") return;

    let requestId: unknown;
    try {
      requestId = (data as { requestId?: unknown }).requestId;
    } catch {
      return;
    }
    if (typeof requestId !== "string" || requestId.length === 0) return;
    if (Array.isArray(data)) {
      rejectRequest(requestId);
      return;
    }

    let params: unknown;
    try {
      params = (data as { params?: unknown }).params;
    } catch {
      rejectRequest(requestId);
      return;
    }
    const allowedParams = resolveAllowedSlashSubagentParams(params);
    if (!allowedParams) {
      rejectRequest(requestId);
      return;
    }

    const request = data as Partial<SlashSubagentRequest>;
    // Trust the request-time context: this event bus is private first-party
    // in-process plumbing, and retaining it avoids stale cached lastUiContext.
    // Only read-only params cross the allowlist above; ctx provenance belongs elsewhere.
    let requesterContext: ExtensionContext | undefined;
    try {
      requesterContext = request.ctx;
    } catch {
      rejectRequest(requestId);
      return;
    }
    const ctx = requesterContext ?? options.getContext();
    if (!ctx) {
      pendingCancels.delete(requestId);
      const response: SlashSubagentResponse = {
        requestId,
        result: {
          content: [
            { type: "text", text: "No active extension context for slash subagent execution." },
          ],
          details: { mode: "single" as const, results: [] },
        },
        isError: true,
        errorText: "No active extension context.",
      };
      options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
      return;
    }

    const controller = new AbortController();
    controllers.set(requestId, controller);

    if (pendingCancels.delete(requestId)) {
      controller.abort();
      const response: SlashSubagentResponse = {
        requestId,
        result: {
          content: [{ type: "text", text: "Cancelled." }],
          details: { mode: "single" as const, results: [] },
        },
        isError: true,
        errorText: "Cancelled before start.",
      };
      options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
      controllers.delete(requestId);
      return;
    }

    options.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });

    try {
      const result = await options.execute(
        requestId,
        allowedParams,
        controller.signal,
        (update) => {
          const progress = update.details?.progress;
          const first = progress?.[0];
          const payload: SlashSubagentUpdate = {
            requestId,
            progress,
            currentTool: first?.currentTool,
            toolCount: first?.toolCount,
          };
          options.events.emit(SLASH_SUBAGENT_UPDATE_EVENT, payload);
        },
        ctx,
      );

      const response: SlashSubagentResponse = {
        requestId,
        result,
        isError: (result as { isError?: boolean }).isError === true,
        errorText: (result as { isError?: boolean }).isError
          ? result.content.find((c) => c.type === "text")?.text
          : undefined,
      };
      options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
    } catch (error) {
      const response: SlashSubagentResponse = {
        requestId,
        result: {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { mode: "single" as const, results: [] },
        },
        isError: true,
        errorText: error instanceof Error ? error.message : String(error),
      };
      options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
    } finally {
      controllers.delete(requestId);
    }
  });

  return {
    cancelAll: () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
      pendingCancels.clear();
    },
    dispose: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.length = 0;
      pendingCancels.clear();
    },
  };
}
