declare module "@earendil-works/pi-agent-core" {
	interface AgentToolResult<T> {
		isError?: boolean;
	}
}

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionUIContext {
		requestRender(): void;
	}
}

export {};
