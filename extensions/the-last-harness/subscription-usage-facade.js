function createRetryableLazyImport(loader) {
    let modulePromise;
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
export class LazyTlhSubscriptionUsageService {
    loadModule = createRetryableLazyImport(() => import("./subscription-usage.js"));
    service;
    servicePromise;
    requestFooterRenderByContext = new WeakMap();
    registerFooterRenderRequest(ctx, requestRender) {
        this.requestFooterRenderByContext.set(ctx, requestRender);
    }
    getSnapshot(provider) {
        return this.service?.getSnapshot(provider);
    }
    getSnapshotForContext(ctx) {
        return this.service?.getSnapshotForContext?.(ctx);
    }
    isEligible(target) {
        return this.service?.isEligible?.(target) === true;
    }
    refresh(ctx, options = {}) {
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
            if (nextSnapshot !== previousSnapshot ||
                nextEligible !== previousEligible ||
                nextProviderSnapshot !== previousProviderSnapshot ||
                nextProviderEligible !== previousProviderEligible) {
                this.requestFooterRenderByContext.get(ctx)?.();
            }
        })
            .catch(() => undefined);
    }
    getService() {
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
export function createLazyTlhSubscriptionUsageService() {
    return new LazyTlhSubscriptionUsageService();
}
