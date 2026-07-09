import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TlhSubscriptionUsageSnapshot, TlhSubscriptionUsageSnapshotProvider, TlhUsageRefreshOptions } from "./types.js";

type TlhSubscriptionUsageServiceLike = TlhSubscriptionUsageSnapshotProvider & {
	refresh(ctx: ExtensionContext | undefined, options?: TlhUsageRefreshOptions): Promise<TlhSubscriptionUsageSnapshot | undefined>;
};

function createRetryableLazyImport<TModule>(loader: () => Promise<TModule>): () => Promise<TModule> {
	let modulePromise: Promise<TModule> | undefined;
	return () => {
		if (!modulePromise) {
			modulePromise = loader().catch((error) => {
				modulePromise = undefined;
				throw error;
			});
		}
		return modulePromise;
	};
}

export class LazyTlhSubscriptionUsageService implements TlhSubscriptionUsageSnapshotProvider {
	private readonly loadModule = createRetryableLazyImport(() => import("./subscription-usage.js"));
	private service: TlhSubscriptionUsageServiceLike | undefined;
	private servicePromise: Promise<TlhSubscriptionUsageServiceLike> | undefined;
	private readonly requestFooterRenderByContext = new WeakMap<ExtensionContext, () => void>();

	registerFooterRenderRequest(ctx: ExtensionContext, requestRender: () => void): void {
		this.requestFooterRenderByContext.set(ctx, requestRender);
	}

	getSnapshot(provider?: string): TlhSubscriptionUsageSnapshot | undefined {
		return this.service?.getSnapshot(provider);
	}

	getSnapshotForContext(ctx: ExtensionContext | undefined): TlhSubscriptionUsageSnapshot | undefined {
		return this.service?.getSnapshotForContext?.(ctx);
	}

	isEligible(target?: string | ExtensionContext): boolean {
		return this.service?.isEligible?.(target) === true;
	}

	refresh(ctx: ExtensionContext, options: TlhUsageRefreshOptions = {}): void {
		const provider = ctx.model?.provider;
		const previousSnapshot = this.getSnapshotForContext(ctx);
		const previousEligible = this.isEligible(ctx);
		const previousProviderSnapshot = provider ? this.getSnapshot(provider) : undefined;
		const previousProviderEligible = provider ? this.isEligible(provider) : false;
		void this.getService()
			.then((service) => service.refresh(ctx, options))
			.then(() => {
				const nextSnapshot = this.getSnapshotForContext(ctx);
				const nextEligible = this.isEligible(ctx);
				const nextProviderSnapshot = provider ? this.getSnapshot(provider) : undefined;
				const nextProviderEligible = provider ? this.isEligible(provider) : false;
				if (
					nextSnapshot !== previousSnapshot ||
					nextEligible !== previousEligible ||
					nextProviderSnapshot !== previousProviderSnapshot ||
					nextProviderEligible !== previousProviderEligible
				) {
					this.requestFooterRenderByContext.get(ctx)?.();
				}
			})
			.catch(() => undefined);
	}

	private getService(): Promise<TlhSubscriptionUsageServiceLike> {
		if (!this.servicePromise) {
			this.servicePromise = this.loadModule()
				.then((module) => {
					if (!this.service) {
						this.service = module.createTlhSubscriptionUsageService();
					}
					return this.service;
				})
				.catch((error) => {
					this.servicePromise = undefined;
					throw error;
				});
		}
		return this.servicePromise;
	}
}

export function createLazyTlhSubscriptionUsageService(): LazyTlhSubscriptionUsageService {
	return new LazyTlhSubscriptionUsageService();
}
