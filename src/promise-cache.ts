import {setInterval} from "timers";

export class CacheConfig<T> {
    // how often to check for expired entries
    public readonly checkInterval: number | "NEVER" = "NEVER";
    // time to live after last access
    public readonly ttl: number | "FOREVER" = "FOREVER";
    // remove rejected promises?
    public readonly removeRejected: boolean = true;
    // fallback for rejected promises
    public readonly onReject: (error: Error, key: string, loader: (key: string) => Promise<T>) => Promise<T>
        = (error) => Promise.reject(error)
    // called before entries are removed because of ttl
    public readonly onRemove: (key: string, p: Promise<T>) => void
        = () => undefined
}

const defaultConfig = new CacheConfig();

class CacheEntry<T> {
    public lastAccess: number = Date.now();

    constructor(public v: T) {

    }

    public get value(): T {
        this.lastAccess = Date.now();
        return this.v;
    }
}

export class PromiseCache<T> {

    private cache: Map<string, CacheEntry<Promise<T>>> = new Map<string, CacheEntry<Promise<T>>>();
    private readonly conf: CacheConfig<T>;
    private readonly stats = new StatsCollector();

    constructor(private readonly loader: (key: string) => Promise<T>, config?: Partial<CacheConfig<T>>) {
        this.conf = Object.assign({}, defaultConfig, config);

        if (this.conf.checkInterval !== "NEVER" && this.conf.ttl !== "FOREVER") {
            const interval = setInterval(() => this.cleanUp(), this.conf.checkInterval);
            interval.unref();
        }
    }

    public get(key: string): Promise<T> {
        const found = this.cache.get(key);

        if (found) {
            this.stats.hit();
            return found.value;
        } else {
            this.stats.miss();
            const loaded = this.loader(key)
                .catch((error) => this.handleReject(error, key));

            this.cache.set(key, new CacheEntry<Promise<T>>(loaded));
            return loaded;
        }
    }

    public statistics(): Stats {
        return this.stats.export(this.cache.size);
    }

    private cleanUp() {
        const now = Date.now();

        // workaround as for(const it of this.cache.entries()) does not work
        Array.from(this.cache.entries()).forEach((it) => {
            const [key, entry] = it;
            if ((entry.lastAccess + (this.conf.ttl as number)) < now) {
                try {
                    this.conf.onRemove(key, entry.value);
                } catch (error) {
                    // nothing we can do
                }
                this.cache.delete(key);
            }
        });
    }

    private handleReject(error: Error, key: string): Promise<T> {
        this.stats.failedLoad();
        const fallback = this.conf.onReject(error, key, this.loader);
        if (this.conf.removeRejected) {
            this.cache.delete(key);
        }
        return fallback;
    }
}

export function singlePromiseCache<T>(loader: () => Promise<T>, config?: Partial<CacheConfig<T>>): () => Promise<T> {
    const cache = new PromiseCache<T>(loader, config);

    return () => cache.get("");
}

export interface Stats {
    readonly misses: number;
    readonly hits: number;
    readonly entries: number;
    readonly failedLoads: number;
}

class StatsCollector {
    private misses: number = 0;
    private hits: number = 0;
    private failedLoads: number = 0;

    public export(currentEntries: number): Stats {
        return {
            entries: currentEntries,
            failedLoads: this.failedLoads,
            hits: this.hits,
            misses: this.misses,
        };
    }

    public hit() {
        this.hits += 1;
    }

    public miss() {
        this.misses += 1;
    }

    public failedLoad() {
        this.failedLoads += 1;
    }
}
