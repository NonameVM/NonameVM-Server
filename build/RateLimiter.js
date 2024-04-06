import { EventEmitter } from "events";
// Class to ratelimit a resource (chatting, logging in, etc)
export default class RateLimiter extends EventEmitter {
    limit;
    interval;
    requestCount;
    limiter;
    limiterSet;
    constructor(limit, interval) {
        super();
        this.limit = limit;
        this.interval = interval;
        this.requestCount = 0;
        this.limiterSet = false;
    }
    // Return value is whether or not the action should be continued
    request() {
        this.requestCount++;
        if (this.requestCount === this.limit) {
            this.emit('limit');
            clearTimeout(this.limiter);
            this.limiterSet = false;
            this.requestCount = 0;
            return false;
        }
        if (!this.limiterSet) {
            this.limiter = setTimeout(() => {
                this.limiterSet = false;
                this.requestCount = 0;
            }, this.interval * 1000);
            this.limiterSet = true;
        }
        return true;
    }
}
