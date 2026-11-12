// Decides which hosts the SDK records: the provider catalog plus hosts the
// customer adds. Everything else (their own services, databases, internal
// APIs) is ignored before any data is kept.

export class HostMatcher {
    private exact = new Set<string>();
    private suffixes: string[] = [];

    constructor(hosts: readonly string[]) {
        this.set(hosts);
    }

    set(hosts: readonly string[]): void {
        const exact = new Set<string>();
        const suffixes: string[] = [];
        for (const raw of hosts) {
            const h = raw.trim().toLowerCase();
            if (h.startsWith('*.')) {
                suffixes.push(h.slice(1));
            } else if (h !== '') {
                exact.add(h);
            }
        }
        this.exact = exact;
        this.suffixes = suffixes;
    }

    matches(host: string): boolean {
        const h = host.toLowerCase();
        if (this.exact.has(h)) {
            return true;
        }
        return this.suffixes.some((s) => h.endsWith(s) && h.length > s.length);
    }
}
